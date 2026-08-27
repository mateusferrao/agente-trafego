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
    const campaignId = await this.createOnAccount(account, "campaigns", {
      name: input.name,
      objective: resolveMetaObjective(input.objectiveGoal),
      special_ad_categories: JSON.stringify(input.specialAdCategories),
      // budget mora no ADSET (ABO) → a Meta (v26) exige declarar explicitamente que a
      // campanha não compartilha orçamento entre adsets (senão exige budget de campanha).
      // O bid_strategy vai no ADSET (ABO) — na campanha exigiria budget de campanha (CBO).
      is_adset_budget_sharing_enabled: "false",
      status: input.status === "active" ? "ACTIVE" : "PAUSED",
    });
    return { campaignId };
  }

  async createAdSet(account: AdAccountRef, input: CreateAdSetInput): Promise<{ adsetId: string }> {
    const conv = resolveAdSetConversion(input.goal, input.pixelId);
    const targeting = await this.resolveTargeting(account, input.targeting);
    const params: Record<string, string> = {
      name: input.name,
      campaign_id: input.campaignId,
      daily_budget: String(input.dailyBudgetMinor),
      optimization_goal: conv.optimizationGoal,
      billing_event: conv.billingEvent,
      // ABO: o adset é dono do budget → o lance mora aqui. "maior volume sem teto" não
      // exige bid_amount (senão a Meta pede valor/restrições de lance — subcode 2490487).
      bid_strategy: "LOWEST_COST_WITHOUT_CAP",
      targeting: JSON.stringify(targeting),
      status: input.status === "active" ? "ACTIVE" : "PAUSED",
    };
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
    if (input.videoId) objectStorySpec["video_data"] = { ...linkData, video_id: input.videoId };
    else objectStorySpec["link_data"] = linkData;
    const creativeId = await this.createOnAccount(account, "adcreatives", {
      name: input.name,
      object_story_spec: JSON.stringify(objectStorySpec),
    });
    return { creativeId };
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

  /** Targeting neutro → Meta. `reuse_adset` lê o targeting da fonte; `advantage_plus` = amplo. */
  private async resolveTargeting(
    account: AdAccountRef,
    spec: CreateAdSetInput["targeting"],
  ): Promise<Record<string, unknown>> {
    if (spec.kind === "reuse_adset") {
      try {
        const { data } = await this.client.request<{ targeting?: Record<string, unknown> }>({
          method: "GET",
          path: spec.sourceAdsetId,
          accessToken: account.accessToken,
          params: { fields: "targeting" },
        });
        if (data.targeting) return data.targeting;
      } catch {
        // fonte indisponível → cai no amplo (Advantage+).
      }
    }
    return {
      geo_locations: { countries: [DEFAULT_ADVANTAGE_GEO_COUNTRY] },
      targeting_automation: { advantage_audience: 1 },
    };
  }

  /**
   * Infere Page/Pixel/objetivo/mídia/link do que a conta já usa (§6). Uma call: 1 anúncio
   * com creative(object_story_spec) + adset(promoted_object) + campaign(objective).
   */
  async inferCreationDefaults(account: AdAccountRef): Promise<CreationDefaults> {
    const accountId = normalizeAdAccountId(account.adAccountId);
    const { data } = await this.client.request<{ data?: ReadonlyArray<RawAdForDefaults> }>({
      method: "GET",
      path: `${accountId}/ads`,
      accessToken: account.accessToken,
      params: {
        fields:
          "id,creative{object_story_spec},adset{promoted_object},campaign{objective}",
        limit: "1",
      },
    });
    const ad = data.data?.[0];
    if (!ad) return {};
    const spec = ad.creative?.object_story_spec;
    const linkData = spec?.link_data;
    const objective = ad.campaign?.objective;
    const goal = objectiveFromCampaign(objective)?.goal as ConversionGoal | undefined;
    const result: CreationDefaults = {
      ...(spec?.page_id ? { pageId: spec.page_id } : {}),
      ...(ad.adset?.promoted_object?.pixel_id ? { pixelId: ad.adset.promoted_object.pixel_id } : {}),
      ...(goal ? { objectiveGoal: goal } : {}),
      ...(linkData?.image_hash ? { imageHash: linkData.image_hash } : {}),
      ...(linkData?.link ? { linkUrl: linkData.link } : {}),
      ...(ad.id ? { sourceAdId: ad.id } : {}),
    };
    return result;
  }
}

/** Forma crua do anúncio p/ inferência de defaults. */
interface RawAdForDefaults {
  readonly id?: string;
  readonly creative?: {
    readonly object_story_spec?: {
      readonly page_id?: string;
      readonly link_data?: { readonly image_hash?: string; readonly link?: string };
    };
  };
  readonly adset?: { readonly promoted_object?: { readonly pixel_id?: string } };
  readonly campaign?: { readonly objective?: string };
}
