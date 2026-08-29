import type {
  AdAccountRef,
  CreateAdCreativeInput,
  CreateAdInput,
  CreateAdSetInput,
  CreateCampaignInput,
  CreationDefaults,
  DuplicateEntityInput,
  DuplicateResult,
} from "@trafego/shared/ports";
import type { ConversionGoal } from "@trafego/shared/types";
import type { UploadMediaInput, VideoStatus } from "@trafego/shared/ports";
import { AdsPlatformError } from "@trafego/shared/ports";
import { MetaGraphClient, MetaApiError, META_GRAPH_VERSION } from "./client.js";
import { normalizeAdAccountId } from "./ids.js";
import {
  objectiveFromCampaign,
  resolveAdSetConversion,
  resolveMetaCta,
  resolveMetaObjective,
} from "./meta-conversion-map.js";
import { copyOf, creativeFormatOf, isReusableCreative, rankAdsForReuse, type RawAdCandidate } from "./creative-select.js";

/** Quantos anúncios buscar p/ ranquear o melhor criativo reusável (1 call, com insights). */
const INFER_CANDIDATES_LIMIT = 25;
/** Quantas copies de topo devolver como aterramento da geração (melhor primeiro). */
const INFER_WINNER_COPY_SAMPLE = 3;

/** Sufixo de edge de cópia da Graph API. */
const COPIES_EDGE = "copies";
const STATUS_ACTIVE = "ACTIVE";
const STATUS_PAUSED = "PAUSED";
const BUDGET_FIELD_DAILY = "daily_budget";

/**
 * Subcode Meta: criativo com "aprimoramentos padrão" (standard_enhancements) descontinuados na v22 —
 * `deep_copy` re-valida o criativo copiado e rejeita. Não-documentado; confirmado no E2E real da Fatia 7.
 * Fica INTERNO ao adapter — nunca vaza pro port neutro (traduzido p/ kind `not_duplicable`).
 */
const LEGACY_ENHANCEMENTS_SUBCODE = 3858504;
/** País default do targeting amplo (Advantage+) quando não há adset provado pra reusar. Beta =
 *  Brasil; geo derivado do mercado/conta = fast-follow (o adapter não recebe o país da conta hoje). */
const DEFAULT_ADVANTAGE_GEO_COUNTRY = "BR";
function isLegacyEnhancementsCopyError(error: unknown): boolean {
  return error instanceof MetaApiError && error.subcode === LEGACY_ENHANCEMENTS_SUBCODE;
}

/**
 * Resposta do `/copies` (adset/campaign) — shape REAL v26 (validado em E2E):
 * `ad_object_ids: [{ ad_object_type, source_id, copied_id }]` (um por filho copiado).
 */
interface CopiesResponse {
  readonly copied_adset_id?: string;
  readonly copied_campaign_id?: string;
  readonly copied_ad_id?: string;
  readonly id?: string;
  readonly ad_object_ids?: ReadonlyArray<{
    readonly ad_object_type?: string;
    readonly source_id?: string;
    readonly copied_id?: string;
  }>;
}

/** Id da cópia, tolerante ao nível (adset/campaign/ad) — a Graph nomeia por tipo. */
function copiedIdOf(body: CopiesResponse): string | null {
  return body.copied_adset_id ?? body.copied_campaign_id ?? body.copied_ad_id ?? body.id ?? null;
}

/**
 * Serviço de CRIAÇÃO/DUPLICAÇÃO na Meta (Fatia 7). Isola o vocabulário Meta (`/copies`,
 * `status_option`, `deep_copy`) — o core/shared falam `DuplicateEntityInput`/`DuplicateResult`.
 */
export class MetaCreationService {
  constructor(private readonly client: MetaGraphClient) {}

  /**
   * Duplica via `POST /{id}/copies` (deep_copy). SÓ a cópia — o override de budget (escala)
   * é passo SEPARADO (`setEntityBudget`), pra a saga persistir o `copiedId` ANTES do budget
   * e não re-copiar num retry (`/copies` não tem idempotência). Retorna cópia + filhos.
   */
  async duplicateEntity(account: AdAccountRef, input: DuplicateEntityInput): Promise<DuplicateResult> {
    const statusOption = input.status === "active" ? STATUS_ACTIVE : STATUS_PAUSED;
    const params: Record<string, string> = {
      deep_copy: "true",
      status_option: statusOption,
    };
    if (input.destinationCampaignId) params["campaign_id"] = input.destinationCampaignId;
    if (input.renameSuffix) params["rename_options"] = JSON.stringify({ rename_suffix: input.renameSuffix });

    let data: CopiesResponse;
    try {
      ({ data } = await this.client.request<CopiesResponse>({
        method: "POST",
        path: `${input.sourceId}/${COPIES_EDGE}`,
        accessToken: account.accessToken,
        params,
      }));
    } catch (error) {
      // criativo legado (standard_enhancements) → traduz p/ kind NEUTRO `not_duplicable`
      // (subcode não sai do adapter); a casca oferece as 2 saídas (subir budget / recriar).
      if (isLegacyEnhancementsCopyError(error)) {
        throw new AdsPlatformError(
          "not_duplicable",
          "deep_copy rejeitado: criativo com recurso descontinuado pela plataforma",
          (error as MetaApiError).userMessage,
        );
      }
      throw error; // demais erros → toAdsError na borda do adapter
    }

    const copiedId = copiedIdOf(data);
    if (!copiedId) {
      throw new Error("Meta /copies não retornou o id da cópia");
    }
    // filhos copiados = os do tipo "ad" (o adset copiado é o copiedId, não um filho).
    const childIds = (data.ad_object_ids ?? [])
      .filter((p) => p.ad_object_type === "ad")
      .map((p) => p.copied_id)
      .filter((id): id is string => typeof id === "string");
    return { copiedId, childIds };
  }

  /** Define o budget diário absoluto de uma entidade (unidade mínima). Idempotente (set). */
  async setEntityBudget(account: AdAccountRef, entityId: string, dailyBudgetMinor: number): Promise<void> {
    await this.client.request({
      method: "POST",
      path: entityId,
      accessToken: account.accessToken,
      params: { [BUDGET_FIELD_DAILY]: String(dailyBudgetMinor) },
    });
  }

  /** POST num edge da conta (campaigns/adsets/adcreatives/ads) → id criado. */
  private async createOnAccount(
    account: AdAccountRef,
    edge: string,
    params: Record<string, string>,
  ): Promise<string> {
    const accountId = normalizeAdAccountId(account.adAccountId);
    const { data } = await this.client.request<{ id?: string }>({
      method: "POST",
      path: `${accountId}/${edge}`,
      accessToken: account.accessToken,
      params,
    });
    if (!data.id) throw new Error(`Meta ${edge} não retornou id`);
    return data.id;
  }

  async createCampaign(account: AdAccountRef, input: CreateCampaignInput): Promise<{ campaignId: string }> {
    // CBO (cópia fiel): orçamento + lance + compartilhamento na CAMPANHA. ABO: nada disso aqui
    // (o adset é dono do budget/lance) e declara-se explicitamente budget_sharing=false (v26).
    const isCbo = (input.dailyBudgetMinor ?? 0) > 0 || (input.lifetimeBudgetMinor ?? 0) > 0;
    const params: Record<string, string> = {
      name: input.name,
      objective: resolveMetaObjective(input.objectiveGoal),
      special_ad_categories: JSON.stringify(input.specialAdCategories),
      status: input.status === "active" ? "ACTIVE" : "PAUSED",
    };
    if (isCbo) {
      // CBO (Advantage campaign budget): orçamento + lance na CAMPANHA. Basta o budget de
      // campanha + bid_strategy — NÃO setar is_adset_budget_sharing_enabled (a Meta infere CBO
      // do budget de campanha; declarar o flag junto é redundante/conflitante). Vitalício de
      // campanha exigiria schedule (end_time) — hoje priorizamos diário (vitalício = fast-follow).
      if ((input.dailyBudgetMinor ?? 0) > 0) params["daily_budget"] = String(input.dailyBudgetMinor);
      else params["lifetime_budget"] = String(input.lifetimeBudgetMinor);
      params["bid_strategy"] = "LOWEST_COST_WITHOUT_CAP";
    } else {
      // ABO: budget mora no ADSET → a Meta (v26) exige declarar que a campanha não compartilha.
      params["is_adset_budget_sharing_enabled"] = "false";
    }
    const campaignId = await this.createOnAccount(account, "campaigns", params);
    return { campaignId };
  }

  async createAdSet(account: AdAccountRef, input: CreateAdSetInput): Promise<{ adsetId: string }> {
    const conv = resolveAdSetConversion(input.goal, input.pixelId);
    const targeting = await this.resolveTargeting(account, input.targeting);
    // CBO: o orçamento/lance estão na campanha → o adset NÃO leva daily_budget/bid_strategy
    // (a Meta rejeita ter budget nos dois níveis). ABO: budget + lance no adset.
    const isAbo = (input.dailyBudgetMinor ?? 0) > 0;
    const params: Record<string, string> = {
      name: input.name,
      campaign_id: input.campaignId,
      optimization_goal: conv.optimizationGoal,
      billing_event: conv.billingEvent,
      targeting: JSON.stringify(targeting),
      status: input.status === "active" ? "ACTIVE" : "PAUSED",
    };
    if (isAbo) {
      params["daily_budget"] = String(input.dailyBudgetMinor);
      // ABO: o adset é dono do budget → o lance mora aqui. "maior volume sem teto" não
      // exige bid_amount (senão a Meta pede valor/restrições de lance — subcode 2490487).
      params["bid_strategy"] = "LOWEST_COST_WITHOUT_CAP";
    }
    if (conv.promotedObject) params["promoted_object"] = JSON.stringify(conv.promotedObject);
    const adsetId = await this.createOnAccount(account, "adsets", params);
    return { adsetId };
  }

  async createAdCreative(account: AdAccountRef, input: CreateAdCreativeInput): Promise<{ creativeId: string }> {
    const linkData: Record<string, unknown> = {
      message: input.copy.primaryText,
      name: input.copy.headline,
      ...(input.copy.description ? { description: input.copy.description } : {}),
      ...(input.linkUrl ? { link: input.linkUrl } : {}),
      ...(input.imageHash ? { image_hash: input.imageHash } : {}),
      call_to_action: {
        type: resolveMetaCta(input.copy.cta),
        ...(input.linkUrl ? { value: { link: input.linkUrl } } : {}),
      },
    };
    const objectStorySpec: Record<string, unknown> = { page_id: input.pageId };
    if (input.videoId) {
      // video_data tem SCHEMA PRÓPRIO (≠ link_data): usa `title` (não `name`), o link vai no
      // call_to_action.value.link, e a Meta EXIGE uma capa (`image_url`/`image_hash`) — sem ela
      // é "Invalid parameter". Sem thumbnail dado, busca a capa preferida do próprio vídeo.
      const thumbUrl = input.imageHash ? undefined : await this.fetchVideoThumbnailUrl(account, input.videoId);
      objectStorySpec["video_data"] = {
        video_id: input.videoId,
        message: input.copy.primaryText,
        title: input.copy.headline,
        ...(input.copy.description ? { link_description: input.copy.description } : {}),
        ...(input.imageHash ? { image_hash: input.imageHash } : thumbUrl ? { image_url: thumbUrl } : {}),
        call_to_action: {
          type: resolveMetaCta(input.copy.cta),
          ...(input.linkUrl ? { value: { link: input.linkUrl } } : {}),
        },
      };
    } else {
      objectStorySpec["link_data"] = linkData;
    }
    const creativeId = await this.createOnAccount(account, "adcreatives", {
      name: input.name,
      object_story_spec: JSON.stringify(objectStorySpec),
    });
    return { creativeId };
  }

  /**
   * Campanha-mãe de um adset + seu orçamento diário (unidade mínima). Usado pra escalar um
   * vencedor sob CBO (orçamento na campanha, não no adset). `null` se não resolver a campanha.
   */
  async getAdSetCampaignBudget(account: AdAccountRef, adsetId: string): Promise<{ campaignId: string; dailyBudgetMinor: number; lifetimeBudgetMinor: number } | null> {
    const { data } = await this.client.request<{ campaign?: { id?: string; daily_budget?: string; lifetime_budget?: string } }>({
      method: "GET",
      path: adsetId,
      accessToken: account.accessToken,
      params: { fields: "campaign{id,daily_budget,lifetime_budget}" },
    });
    const c = data.campaign;
    if (!c?.id) return null;
    return { campaignId: c.id, dailyBudgetMinor: Number(c.daily_budget ?? 0), lifetimeBudgetMinor: Number(c.lifetime_budget ?? 0) };
  }

  /** Capa (thumbnail) de um vídeo — a preferida da Meta, senão a 1ª. Usada como `image_url`
   *  obrigatório no `video_data`. Falha → undefined (o caller decide se ainda tenta criar). */
  private async fetchVideoThumbnailUrl(account: AdAccountRef, videoId: string): Promise<string | undefined> {
    try {
      const { data } = await this.client.request<{ thumbnails?: { data?: ReadonlyArray<{ uri?: string; is_preferred?: boolean }> } }>({
        method: "GET",
        path: videoId,
        accessToken: account.accessToken,
        params: { fields: "thumbnails{uri,is_preferred}" },
      });
      const list = data.thumbnails?.data ?? [];
      return list.find((t) => t.is_preferred)?.uri ?? list[0]?.uri;
    } catch {
      return undefined;
    }
  }

  async createAd(account: AdAccountRef, input: CreateAdInput): Promise<{ adId: string }> {
    const adId = await this.createOnAccount(account, "ads", {
      name: input.name,
      adset_id: input.adsetId,
      creative: JSON.stringify({ creative_id: input.creativeId }),
      status: input.status === "active" ? "ACTIVE" : "PAUSED",
    });
    return { adId };
  }

  /** POST multipart num edge da conta (upload de mídia — o client de query não faz multipart). */
  private async uploadMultipart<T>(account: AdAccountRef, edge: string, field: string, input: UploadMediaInput): Promise<T> {
    const accountId = normalizeAdAccountId(account.adAccountId);
    const url = `https://graph.facebook.com/${META_GRAPH_VERSION}/${accountId}/${edge}`;
    const fd = new FormData();
    fd.append(field, new Blob([input.bytes], { type: input.contentType }), input.filename);
    const res = await fetch(url, { method: "POST", headers: { Authorization: `Bearer ${account.accessToken}` }, body: fd });
    const text = await res.text();
    if (!res.ok) throw new Error(`upload ${edge} falhou (HTTP ${res.status}): ${text.slice(0, 200)}`);
    return JSON.parse(text) as T;
  }

  async uploadImage(account: AdAccountRef, input: UploadMediaInput): Promise<{ imageHash: string }> {
    // /adimages devolve { images: { <filename>: { hash, url } } }.
    const data = await this.uploadMultipart<{ images?: Record<string, { hash?: string }> }>(account, "adimages", "filename", input);
    const first = Object.values(data.images ?? {})[0];
    if (!first?.hash) throw new Error("Meta /adimages não retornou hash");
    return { imageHash: first.hash };
  }

  async uploadVideo(account: AdAccountRef, input: UploadMediaInput): Promise<{ videoId: string }> {
    const data = await this.uploadMultipart<{ id?: string }>(account, "advideos", "source", input);
    if (!data.id) throw new Error("Meta /advideos não retornou id");
    return { videoId: data.id };
  }

  async getVideoStatus(account: AdAccountRef, videoId: string): Promise<VideoStatus> {
    const { data } = await this.client.request<{ status?: { video_status?: string } }>({
      method: "GET",
      path: videoId,
      accessToken: account.accessToken,
      params: { fields: "status" },
    });
    const s = data.status?.video_status;
    return { status: s === "ready" ? "ready" : s === "error" ? "error" : "processing" };
  }

  /**
   * Targeting neutro → Meta. `reuse_adset` lê o targeting da fonte; `custom_audiences` reusa
   * geo/idade da fonte e TROCA o público (include/exclude) com expansões zeradas (remarketing);
   * `advantage_plus` = amplo. SWITCH EXAUSTIVO (`never`): um kind não tratado é erro de
   * compilação, não fall-through silencioso p/ amplo num caminho que gasta dinheiro.
   */
  private async resolveTargeting(
    account: AdAccountRef,
    spec: CreateAdSetInput["targeting"],
  ): Promise<Record<string, unknown>> {
    switch (spec.kind) {
      case "reuse_adset":
        return (await this.sourceAdsetTargeting(account, spec.sourceAdsetId)) ?? this.broadTargeting();
      case "custom_audiences": {
        // remarketing: base = geo/idade da fonte (as "7 cidades" reais, não parseadas), com o
        // público trocado e expansões zeradas (§guidance). Sem a fonte → amplo com o público.
        const base = (await this.sourceAdsetTargeting(account, spec.sourceAdsetId)) ?? {};
        const out: Record<string, unknown> = {
          ...(base["geo_locations"] ? { geo_locations: base["geo_locations"] } : { geo_locations: { countries: [DEFAULT_ADVANTAGE_GEO_COUNTRY] } }),
          ...(base["age_min"] !== undefined ? { age_min: base["age_min"] } : {}),
          ...(base["age_max"] !== undefined ? { age_max: base["age_max"] } : {}),
          // troca o público: inclui os escolhidos, exclui os escolhidos; expansões OFF.
          ...(spec.includeIds.length > 0 ? { custom_audiences: spec.includeIds.map((id) => ({ id })) } : {}),
          ...(spec.excludeIds.length > 0 ? { excluded_custom_audiences: spec.excludeIds.map((id) => ({ id })) } : {}),
          targeting_automation: { advantage_audience: 0 },
        };
        return out;
      }
      case "advantage_plus":
        return this.broadTargeting();
      default: {
        const _exhaustive: never = spec;
        return _exhaustive;
      }
    }
  }

  /** Targeting cru do adset-fonte (geo/idade/público) — reusado por reuse_adset e custom_audiences. */
  private async sourceAdsetTargeting(account: AdAccountRef, sourceAdsetId: string): Promise<Record<string, unknown> | null> {
    try {
      const { data } = await this.client.request<{ targeting?: Record<string, unknown> }>({
        method: "GET",
        path: sourceAdsetId,
        accessToken: account.accessToken,
        params: { fields: "targeting" },
      });
      return data.targeting ?? null;
    } catch {
      return null; // fonte indisponível → o chamador cai no amplo
    }
  }

  private broadTargeting(): Record<string, unknown> {
    return {
      geo_locations: { countries: [DEFAULT_ADVANTAGE_GEO_COUNTRY] },
      targeting_automation: { advantage_audience: 1 },
    };
  }

  /**
   * Infere Page/Pixel/objetivo/mídia/link/copy do MELHOR criativo veiculando (§6 + decisão
   * A do dono, Fatia 7). Antes pegava um anúncio ARBITRÁRIO (`limit:1`, sem ordem/status) e
   * vendia como "campeão" — falso. Agora busca os anúncios ATIVOS com insights (1 call),
   * ranqueia por desempenho de negócio (`rankAdsForReuse`) e escolhe o melhor; devolve
   * também a copy dos melhores (aterramento da geração). Sem ativos → cai no que houver
   * (cold-start ainda reusa uma mídia real). O ranqueamento é PURO/testável.
   */
  async inferCreationDefaults(account: AdAccountRef): Promise<CreationDefaults> {
    const accountId = normalizeAdAccountId(account.adAccountId);
    const { data } = await this.client.request<{ data?: ReadonlyArray<RawAdCandidate> }>({
      method: "GET",
      path: `${accountId}/ads`,
      accessToken: account.accessToken,
      params: {
        fields:
          "id,effective_status,creative{object_story_spec},adset{promoted_object},campaign{objective},insights.date_preset(last_30d){spend,actions}",
        limit: String(INFER_CANDIDATES_LIMIT),
      },
    });
    const ranked = rankAdsForReuse(data.data ?? []);
    // FONTE de reuso = o melhor anúncio REUSÁVEL (imagem/vídeo único). Se o #1 por desempenho
    // for carrossel/catálogo (não-clonável hoje), NÃO zera o pick: usa o melhor reusável abaixo
    // dele + sinaliza `unsupportedTopFormat` p/ a casca ser transparente com o dono.
    const top = ranked[0];
    // !isReusable garante que o formato ∈ {carousel,catalog,other} (nunca image/video).
    const unsupportedTopFormat: "carousel" | "catalog" | "other" | undefined =
      top && !isReusableCreative(top.ad) ? (creativeFormatOf(top.ad) as "carousel" | "catalog" | "other") : undefined;
    const best = ranked.find((r) => isReusableCreative(r.ad))?.ad;
    if (!best) {
      // nenhum criativo reusável — mas talvez o topo seja um formato não suportado: reporta o
      // formato (sem mídia) p/ a casca explicar o porquê, em vez de só "não achei criativo".
      return unsupportedTopFormat ? { unsupportedTopFormat } : {};
    }
    const spec = best.creative?.object_story_spec;
    const linkData = spec?.link_data;
    // link de destino: imagem → link_data.link; vídeo → call_to_action.value.link do video_data.
    const reuseLink = linkData?.link ?? spec?.video_data?.call_to_action?.value?.link;
    const goal = objectiveFromCampaign(best.campaign?.objective)?.goal as ConversionGoal | undefined;
    const winnerCopy = ranked
      .slice(0, INFER_WINNER_COPY_SAMPLE)
      .map((r) => copyOf(r.ad))
      .filter((c): c is { primaryText?: string; headline?: string } => c !== null);
    const result: CreationDefaults = {
      ...(spec?.page_id ? { pageId: spec.page_id } : {}),
      ...(best.adset?.promoted_object?.pixel_id ? { pixelId: best.adset.promoted_object.pixel_id } : {}),
      ...(goal ? { objectiveGoal: goal } : {}),
      ...(linkData?.image_hash ? { imageHash: linkData.image_hash } : {}),
      ...(spec?.video_data?.video_id ? { videoId: spec.video_data.video_id } : {}),
      ...(reuseLink ? { linkUrl: reuseLink } : {}),
      ...(best.id ? { sourceAdId: best.id } : {}),
      ...(winnerCopy.length > 0 ? { winnerCopy } : {}),
      ...(unsupportedTopFormat ? { unsupportedTopFormat } : {}),
    };
    return result;
  }
}
