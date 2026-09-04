import type {
  AdAccountRef,
  CreateAdCreativeInput,
  CreateAdInput,
  CreateAdSetInput,
  CreateCampaignInput,
  CreationDefaults,
  DeliveryEstimateInput,
  DuplicateEntityInput,
  DuplicateResult,
} from "@trafego/shared/ports";
import type { AudienceProfile, ConversionGoal, DeliveryEstimate, ResolvedAudienceSnapshot } from "@trafego/shared/types";
import type { UploadMediaInput, VideoStatus } from "@trafego/shared/ports";
import { AdsPlatformError } from "@trafego/shared/ports";
import { MetaGraphClient, MetaApiError, META_GRAPH_VERSION } from "./client.js";
import { callWithGovernor } from "./call-with-governor.js";
import type { MetaGovernor } from "./governor.js";
import { normalizeAdAccountId } from "./ids.js";
import { audienceFromTargeting, type RawTargeting } from "./meta-audience-map.js";
import {
  objectiveFromCampaign,
  resolveAdSetConversion,
  resolveMetaCta,
  resolveMetaObjective,
} from "./meta-conversion-map.js";
import { copyOf, creativeFormatOf, isReusableCreative, rankAdsForReuse, type RawAdCandidate } from "./creative-select.js";
import { DEFAULT_TARGETING_GEO_COUNTRY, explicitTargetingToRaw } from "./targeting-map.js";

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
 * Subcodes Meta em que a ENTIDADE-FONTE não pode ser copiada COMO ESTÁ (`/copies` re-valida e
 * recusa) — determinístico, não-transitório. Nomeado p/ auditar + estender sem string mágica.
 * `criativo_legado`: standard_enhancements descontinuado (v22, re-validado no `deep_copy`).
 * `atribuicao_descontinuada`: janela de atribuição que o objetivo não suporta mais (confirmado em
 * spike real). Ambos INTERNOS ao adapter (subcode nunca vaza pro port) → kind `not_duplicable`,
 * que é o gatilho da reconstrução por-nó (fallback via rota de criação).
 */
const NOT_DUPLICABLE_SUBCODES = {
  criativo_legado: 3858504,
  atribuicao_descontinuada: 1885423,
} as const;
const NOT_DUPLICABLE_SUBCODE_SET: ReadonlySet<number> = new Set(Object.values(NOT_DUPLICABLE_SUBCODES));
/** País default do targeting amplo (Advantage+) quando não há adset provado pra reusar. Fonte
 *  única em `targeting-map` (compartilhada com o `explicit`); alias local p/ legibilidade. */
const DEFAULT_ADVANTAGE_GEO_COUNTRY = DEFAULT_TARGETING_GEO_COUNTRY;
function isNotDuplicableCopyError(error: unknown): boolean {
  return error instanceof MetaApiError && typeof error.subcode === "number" && NOT_DUPLICABLE_SUBCODE_SET.has(error.subcode);
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

/** Página de filhos (`/adsets`/`/ads`) — só o `id` + o cursor de paginação. */
interface ChildListPage {
  readonly data?: ReadonlyArray<{ readonly id: string }>;
  readonly paging?: { readonly next?: string; readonly cursors?: { readonly after?: string } };
}

/** Id da cópia, tolerante ao nível (adset/campaign/ad) — a Graph nomeia por tipo. */
function copiedIdOf(body: CopiesResponse): string | null {
  return body.copied_adset_id ?? body.copied_campaign_id ?? body.copied_ad_id ?? body.id ?? null;
}

/** Resposta do `/delivery_estimate` (v26): `data:[{ estimate_dau, estimate_mau_*, estimate_ready }]`.
 *  `-1` = a plataforma ainda não estimou (público/lookalike novo) → tratado como "sem contagem". */
interface RawDeliveryEstimate {
  readonly estimate_dau?: number;
  readonly estimate_mau_lower_bound?: number;
  readonly estimate_mau_upper_bound?: number;
  readonly estimate_ready?: boolean;
}
interface RawDeliveryEstimatePage {
  readonly data?: readonly RawDeliveryEstimate[];
}
/** contagem válida = número presente e ≥ 0 (a Meta devolve -1 quando ainda não estimou). */
function positiveCount(n: number | undefined): number | undefined {
  return typeof n === "number" && n >= 0 ? n : undefined;
}

/**
 * Serviço de CRIAÇÃO/DUPLICAÇÃO na Meta (Fatia 7). Isola o vocabulário Meta (`/copies`,
 * `status_option`, `deep_copy`) — o core/shared falam `DuplicateEntityInput`/`DuplicateResult`.
 */
export class MetaCreationService {
  constructor(private readonly client: MetaGraphClient) {}

  /**
   * Duplica reconstruindo a árvore com cópias RASAS (`/copies` deep_copy=false = 1 objeto por
   * chamada, sempre dentro do limite síncrono da Meta <3). O deep_copy da ÁRVORE inteira estoura
   * em qualquer campanha real (spike real, subcode 1885194); o async batch não aceita `/copies`.
   * ATÔMICO: falha em qualquer nó → DELETA a raiz criada (cascata) e re-lança — devolve árvore
   * completa OU nada. O override de budget segue passo SEPARADO (`setEntityBudget`).
   */
  async duplicateEntity(account: AdAccountRef, input: DuplicateEntityInput): Promise<DuplicateResult> {
    if (input.sourceLevel === "campaign") {
      const newCampaignId = await this.shallowCopy(account, input.sourceId, input.status, undefined, input.renameSuffix);
      try {
        const childAdsetIds: string[] = [];
        const childIds: string[] = [];
        for (const srcAdset of await this.listChildIds(account, input.sourceId, "adsets")) {
          const { newAdsetId, newAdIds } = await this.copyAdsetInto(account, srcAdset, input.status, { campaign_id: newCampaignId });
          childAdsetIds.push(newAdsetId);
          childIds.push(...newAdIds);
        }
        return { copiedId: newCampaignId, childIds, childAdsetIds };
      } catch (error) {
        await this.revertRoot(account, newCampaignId);
        throw error;
      }
    }
    if (input.sourceLevel === "adset") {
      // conjunto vencedor → casca do conjunto (na campanha destino, quando houver) + seus anúncios.
      const reparent = input.destinationCampaignId ? { campaign_id: input.destinationCampaignId } : undefined;
      const newAdsetId = await this.shallowCopy(account, input.sourceId, input.status, reparent, input.renameSuffix);
      try {
        const newAdIds = await this.copyAdsInto(account, input.sourceId, input.status, newAdsetId);
        return { copiedId: newAdsetId, childIds: newAdIds, childAdsetIds: [] };
      } catch (error) {
        await this.revertRoot(account, newAdsetId);
        throw error;
      }
    }
    // anúncio = folha (1 objeto)
    const reparent = input.destinationCampaignId ? { campaign_id: input.destinationCampaignId } : undefined;
    const copiedId = await this.shallowCopy(account, input.sourceId, input.status, reparent, input.renameSuffix);
    return { copiedId, childIds: [], childAdsetIds: [] };
  }

  /** Copia UM conjunto (raso) na campanha destino + cada anúncio dele (raso, reparent). */
  private async copyAdsetInto(
    account: AdAccountRef,
    srcAdset: string,
    status: "active" | "paused",
    reparent: { campaign_id: string },
  ): Promise<{ newAdsetId: string; newAdIds: string[] }> {
    const newAdsetId = await this.shallowCopy(account, srcAdset, status, reparent);
    const newAdIds = await this.copyAdsInto(account, srcAdset, status, newAdsetId);
    return { newAdsetId, newAdIds };
  }

  /** Copia cada anúncio de `srcAdset` (raso) reparenteado no conjunto novo. */
  private async copyAdsInto(account: AdAccountRef, srcAdset: string, status: "active" | "paused", newAdsetId: string): Promise<string[]> {
    const newAdIds: string[] = [];
    for (const srcAd of await this.listChildIds(account, srcAdset, "ads")) {
      newAdIds.push(await this.shallowCopy(account, srcAd, status, { adset_id: newAdsetId }));
    }
    return newAdIds;
  }

  /**
   * Cópia RASA de 1 objeto (`deep_copy=false`) via `/copies`, com reparent (`campaign_id`/`adset_id`)
   * e rename opcionais. Criativo legado (subcode 3858504) → `AdsPlatformError` NEUTRO `not_duplicable`
   * (subcode não vaza; a casca oferece as 2 saídas). Demais erros propagam p/ `toAdsError`.
   */
  private async shallowCopy(
    account: AdAccountRef,
    sourceId: string,
    status: "active" | "paused",
    reparent?: { campaign_id?: string; adset_id?: string },
    renameSuffix?: string,
  ): Promise<string> {
    const params: Record<string, string> = { deep_copy: "false", status_option: status === "active" ? STATUS_ACTIVE : STATUS_PAUSED };
    if (reparent?.campaign_id) params["campaign_id"] = reparent.campaign_id;
    if (reparent?.adset_id) params["adset_id"] = reparent.adset_id;
    if (renameSuffix) params["rename_options"] = JSON.stringify({ rename_suffix: renameSuffix });
    try {
      const { data } = await this.client.request<CopiesResponse>({ method: "POST", path: `${sourceId}/${COPIES_EDGE}`, accessToken: account.accessToken, params });
      const id = copiedIdOf(data);
      if (!id) throw new Error("Meta /copies não retornou o id da cópia");
      return id;
    } catch (error) {
      if (isNotDuplicableCopyError(error)) {
        throw new AdsPlatformError("not_duplicable", "cópia rejeitada pela plataforma (config descontinuada da entidade-fonte)", (error as MetaApiError).userMessage);
      }
      throw error;
    }
  }

  /** Lista os ids dos filhos de um nó (`adsets`/`ads`), paginando. Só `id` (barato). */
  private async listChildIds(account: AdAccountRef, parentId: string, edge: "adsets" | "ads"): Promise<string[]> {
    const ids: string[] = [];
    let params: Record<string, string> | undefined = { fields: "id", limit: "100" };
    while (params) {
      const page: ChildListPage = (await this.client.request<ChildListPage>({ method: "GET", path: `${parentId}/${edge}`, accessToken: account.accessToken, params })).data;
      for (const c of page.data ?? []) ids.push(c.id);
      const after = page.paging?.cursors?.after;
      params = page.paging?.next && after ? { fields: "id", limit: "100", after } : undefined;
    }
    return ids;
  }

  /** DELETE best-effort da raiz criada (limpeza atômica em falha). Falha na limpeza NÃO mascara o
   *  erro original (a casca avisa p/ apagar manual via o desfecho `failed`). */
  private async revertRoot(account: AdAccountRef, rootId: string): Promise<void> {
    try {
      await this.client.request({ method: "DELETE", path: rootId, accessToken: account.accessToken });
    } catch {
      /* limpeza falhou — o erro original prevalece */
    }
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

  async createAdSet(account: AdAccountRef, input: CreateAdSetInput): Promise<{ adsetId: string; targetingFallback: boolean }> {
    const conv = resolveAdSetConversion(input.goal, input.pixelId);
    const { targeting, fallback } = await this.resolveTargeting(account, input.targeting);
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
    return { adsetId, targetingFallback: fallback };
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

  /**
   * Estima o alcance de um targeting COMBINADO (Fatia 7 — fast-follow). Reusa a MESMA montagem de
   * targeting + optimization_goal do `createAdSet` (fiel ao que será criado) e chama
   * `GET /act_{id}/delivery_estimate`. Vocabulário Meta (estimate_dau/mau/-1) traduzido p/ neutro;
   * sob o governor (read). Erro sobe → a casca degrada (best-effort, não bloqueia a proposta).
   */
  async deliveryEstimate(account: AdAccountRef, input: DeliveryEstimateInput, governor: MetaGovernor): Promise<DeliveryEstimate> {
    const accountId = normalizeAdAccountId(account.adAccountId);
    const { targeting } = await this.resolveTargeting(account, input.targeting);
    const conv = resolveAdSetConversion(input.goal, input.pixelId);
    const body = await callWithGovernor<RawDeliveryEstimatePage>(
      accountId,
      () =>
        this.client.request<RawDeliveryEstimatePage>({
          method: "GET",
          path: `${accountId}/delivery_estimate`,
          accessToken: account.accessToken,
          params: { optimization_goal: conv.optimizationGoal, targeting_spec: JSON.stringify(targeting) },
        }),
      { governor },
    );
    const row = body.data?.[0];
    if (!row || row.estimate_ready !== true) return { ready: false };
    const dau = positiveCount(row.estimate_dau);
    const mauMin = positiveCount(row.estimate_mau_lower_bound);
    const mauMax = positiveCount(row.estimate_mau_upper_bound);
    return {
      ready: true,
      ...(dau !== undefined ? { dailyActiveUsers: dau } : {}),
      ...(mauMin !== undefined ? { monthlyReachMin: mauMin } : {}),
      ...(mauMax !== undefined ? { monthlyReachMax: mauMax } : {}),
    };
  }

  /**
   * Estima o alcance de um adset EXISTENTE (teto de escala por audiência, Fase 4) — chama
   * `GET /{adsetId}/delivery_estimate` SEM `targeting_spec`/`optimization_goal` (a Meta usa
   * a config ATUAL do próprio adset como default — não precisamos reconstruir o targeting).
   * Reusado pelo guard reativo de `scale_winner`/`increase_budget`: chamado só quando já há
   * uma proposta de escalar aquela entidade neste run (nunca varre a conta à toa).
   */
  async deliveryEstimateForAdSet(account: AdAccountRef, adsetId: string, governor: MetaGovernor): Promise<DeliveryEstimate> {
    const body = await callWithGovernor<RawDeliveryEstimatePage>(
      normalizeAdAccountId(account.adAccountId),
      () => this.client.request<RawDeliveryEstimatePage>({ method: "GET", path: `${adsetId}/delivery_estimate`, accessToken: account.accessToken }),
      { governor },
    );
    const row = body.data?.[0];
    if (!row || row.estimate_ready !== true) return { ready: false };
    const dau = positiveCount(row.estimate_dau);
    const mauMin = positiveCount(row.estimate_mau_lower_bound);
    const mauMax = positiveCount(row.estimate_mau_upper_bound);
    return {
      ready: true,
      ...(dau !== undefined ? { dailyActiveUsers: dau } : {}),
      ...(mauMin !== undefined ? { monthlyReachMin: mauMin } : {}),
      ...(mauMax !== undefined ? { monthlyReachMax: mauMax } : {}),
    };
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

  /** Targeting amplo default (Advantage+) — sem trava de geo/audience. */
  private advantagePlusTargeting(): Record<string, unknown> {
    return {
      geo_locations: { countries: [DEFAULT_ADVANTAGE_GEO_COUNTRY] },
      targeting_automation: { advantage_audience: 1 },
    };
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
      return null;
    }
  }

  /**
   * Perfil de público NEUTRO de um adset isolado (P0.2/P1) — reusa a MESMA leitura de
   * `sourceAdsetTargeting` (não duplica a chamada Graph), mapeada via `audienceFromTargeting`.
   * `null` = leitura falhou/adset sumiu — o caller (propose) decide bloquear, nunca herda às cegas.
   */
  async getAudienceProfile(account: AdAccountRef, adsetId: string): Promise<AudienceProfile | null> {
    const raw = await this.sourceAdsetTargeting(account, adsetId);
    if (!raw) return null;
    return audienceFromTargeting(raw as RawTargeting) ?? null;
  }

  /** `geo` neutro (§shared) → `geo_locations` cru da Meta — só `key` (nunca `name`, que é só p/ eco). */
  private geoToRaw(geo: ResolvedAudienceSnapshot["geo"]): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    if (geo.countries?.length) out["countries"] = geo.countries;
    if (geo.regions?.length) out["regions"] = geo.regions.map((r) => ({ key: r.key }));
    if (geo.cities?.length) out["cities"] = geo.cities.map((c) => ({ key: c.key }));
    return out;
  }

  /** Snapshot resolvido (P0.2/P1, subfatia 2) → `targeting` cru pronto pra Meta, SEM reler nada —
   *  expansão sempre EXPLÍCITA (nunca ausente, nunca deixa a Meta aplicar o default 1 dela). */
  private snapshotToRawTargeting(snapshot: ResolvedAudienceSnapshot): Record<string, unknown> {
    // Slice 6: reconstrói o flexible_spec (interesses/comportamentos com id) preservado no snapshot →
    // a cópia reuse_adset mantém o targeting detalhado da fonte (antes só geo/idade/expansão).
    const iGroups = (snapshot.interestGroups ?? []).filter((g) => g.length > 0).map((g) => ({ interests: g.map((i) => ({ id: i.id })) }));
    const bGroups = (snapshot.behaviorGroups ?? []).filter((g) => g.length > 0).map((g) => ({ behaviors: g.map((b) => ({ id: b.id })) }));
    const flexible_spec = [...iGroups, ...bGroups];
    // geo do snapshot pode sair VAZIO quando a fonte usa geo NÃO-capturável (Advantage geo /
    // custom_locations / clusters) — a Meta rejeita `geo_locations` vazio ("Falta uma localização").
    // Fallback seguro: país padrão (a cópia fica válida; fidelidade fina de geo exótico = fast-follow).
    const geoRaw = this.geoToRaw(snapshot.geo);
    const geo_locations = Object.keys(geoRaw).length > 0 ? geoRaw : { countries: [DEFAULT_ADVANTAGE_GEO_COUNTRY] };
    return {
      geo_locations,
      ...(snapshot.ageMin !== undefined ? { age_min: snapshot.ageMin } : {}),
      ...(snapshot.ageMax !== undefined ? { age_max: snapshot.ageMax } : {}),
      ...(flexible_spec.length > 0 ? { flexible_spec } : {}),
      // Slice 9: reemite os públicos salvos da fonte (cópia reuse_adset de remarketing preserva o
      // público quente — antes o snapshot só tinha geo/idade/expansão/interesses e virava prospecção).
      ...(snapshot.customAudienceIncludeIds && snapshot.customAudienceIncludeIds.length > 0 ? { custom_audiences: snapshot.customAudienceIncludeIds.map((id) => ({ id })) } : {}),
      ...(snapshot.customAudienceExcludeIds && snapshot.customAudienceExcludeIds.length > 0 ? { excluded_custom_audiences: snapshot.customAudienceExcludeIds.map((id) => ({ id })) } : {}),
      targeting_automation: { advantage_audience: snapshot.expansionRaw.advantageAudience },
      targeting_relaxation_types: {
        custom_audience: snapshot.expansionRaw.relaxCustomAudience,
        lookalike: snapshot.expansionRaw.relaxLookalike,
      },
    };
  }

  /**
   * Targeting neutro → Meta. `reuse_adset`: com `resolved` (snapshot do propose) monta DIRETO sem
   * reler a Meta — o snapshot já traz geo/idade/expansão/interesses/behaviors/públicos salvos (cópia
   * fiel); sem `resolved` (rascunho LEGADO) lê a fonte ao vivo e NORMALIZA a expansão (nunca AS-IS).
   * `explicit` = público por primitivos (geo+raio/idade/gênero/grupos de interesse/behavior/públicos
   * salvos), expansão SEMPRE fechada. `advantage_plus` = amplo. O kind `custom_audiences` foi colapsado
   * em `explicit` (Slice 1). SWITCH EXAUSTIVO (`never`).
   */
  private async resolveTargeting(
    account: AdAccountRef,
    spec: CreateAdSetInput["targeting"],
  ): Promise<{ targeting: Record<string, unknown>; fallback: boolean }> {
    switch (spec.kind) {
      case "reuse_adset": {
        // caminho normal: o rascunho SEMPRE nasce com retrato (Bug 3 — propose/toggle snapshotam).
        if (spec.resolved) return { targeting: this.snapshotToRawTargeting(spec.resolved), fallback: false };
        // belt-and-suspenders p/ rascunho LEGADO sem retrato: NUNCA devolve AS-IS — a Meta liga
        // advantage_audience no default (v23+) quando os flags vêm ausentes. Normaliza a expansão
        // (preserva o que a fonte trazia, fecha o que estava ausente).
        const src = await this.sourceAdsetTargeting(account, spec.sourceAdsetId);
        if (!src) return { targeting: this.advantagePlusTargeting(), fallback: true };
        const ta = (src["targeting_automation"] ?? {}) as { advantage_audience?: 0 | 1 };
        const tr = (src["targeting_relaxation_types"] ?? {}) as { custom_audience?: 0 | 1; lookalike?: 0 | 1 };
        return {
          targeting: {
            ...src,
            targeting_automation: { advantage_audience: ta.advantage_audience ?? 0 },
            targeting_relaxation_types: { custom_audience: tr.custom_audience ?? 0, lookalike: tr.lookalike ?? 0 },
          },
          fallback: false,
        };
      }
      case "advantage_plus":
        return { targeting: this.advantagePlusTargeting(), fallback: false };
      case "explicit":
        // público NOVO por primitivos (Fase 1) — mapeamento PURO extraído p/ `targeting-map`
        // (fonte única, reusada pela escrita de adjust_audience na Fatia C). Expansão sempre fechada.
        return { targeting: explicitTargetingToRaw(spec), fallback: false };
      default: {
        // Exaustivo em compile-time; em runtime um rascunho LEGADO no jsonb (ex: kind colapsado) NÃO
        // pode devolver targeting undefined (adset sem targeting = erro cru da Meta) — cai em amplo
        // com fallback:true (o caller sinaliza), nunca crasha.
        const _exhaustive: never = spec;
        void _exhaustive;
        return { targeting: this.advantagePlusTargeting(), fallback: true };
      }
    }
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
          "id,effective_status,creative{object_story_spec},adset{id,promoted_object},campaign{objective},insights.date_preset(last_30d){spend,actions}",
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
      // capa: imagem → link_data.image_hash; VÍDEO → video_data.image_hash (a capa do anúncio-fonte,
      // acessível — evita o fetch de thumbnails do vídeo que pode falhar com #10). É o `image_hash`
      // do video_data que o createAdCreative reusa como capa obrigatória.
      ...((linkData?.image_hash ?? spec?.video_data?.image_hash) ? { imageHash: (linkData?.image_hash ?? spec?.video_data?.image_hash)! } : {}),
      ...(spec?.video_data?.video_id ? { videoId: spec.video_data.video_id } : {}),
      ...(reuseLink ? { linkUrl: reuseLink } : {}),
      ...(best.id ? { sourceAdId: best.id } : {}),
      ...(best.adset?.id ? { sourceAdsetId: best.adset.id } : {}),
      ...(winnerCopy.length > 0 ? { winnerCopy } : {}),
      ...(unsupportedTopFormat ? { unsupportedTopFormat } : {}),
    };
    return result;
  }
}
