import type { CampaignStructure } from "@trafego/shared";
import { DEFAULT_CONVERSION_GOAL } from "@trafego/shared";
import type { AdAccountRef } from "@trafego/shared/ports";
import type { MetaGraphClient } from "./client.js";
import { callWithGovernor } from "./call-with-governor.js";
import type { MetaGovernor } from "./governor.js";
import { audienceFromTargeting, type RawTargeting } from "./meta-audience-map.js";
import { objectiveFromAdSet, objectiveFromCampaign, type RawPromotedObject } from "./meta-conversion-map.js";

/**
 * Lê a estrutura NEUTRA de uma campanha existente p/ CÓPIA FIEL (Fatia 7) — escopado à
 * campanha (nunca account-wide, ao contrário de `inferCreationDefaults`). Vocabulário Meta
 * (CBO via budget na campanha, optimization_goal, promoted_object) isolado aqui. O reuso do
 * `creative_id` por referência preserva o `object_story_spec`/CTA/link do CRIATIVO — MAS o
 * `promoted_object.page_id` do CONJUNTO é um campo à parte, exigido pela Meta em CONVERSAS
 * (CTWA)/LEAD-sem-pixel, que o creative reuse NÃO preserva: por isso capturamos `pixelId` E
 * `pageId` do adset-fonte e threadamos pro createAdSet da cópia (bug de prod: cópia de conversas
 * recusada sem a Página).
 */
export const COPY_STRUCTURE_ADSET_LIMIT = 25;
export const COPY_STRUCTURE_AD_LIMIT = 50;

interface RawCampaignNode {
  readonly name?: string;
  readonly objective?: string;
  readonly daily_budget?: string;
  readonly lifetime_budget?: string;
  readonly special_ad_categories?: readonly string[];
}
interface RawAdSetNode {
  readonly id?: string;
  readonly effective_status?: string;
  readonly daily_budget?: string;
  readonly lifetime_budget?: string;
  readonly optimization_goal?: string;
  readonly promoted_object?: RawPromotedObject;
  readonly targeting?: RawTargeting;
}
interface RawAdNode {
  readonly id?: string;
  readonly effective_status?: string;
  readonly creative?: { readonly id?: string };
}

const ACTIVE_STATUS = "ACTIVE";

export class MetaCampaignStructureService {
  private readonly client: MetaGraphClient;
  private readonly governor: MetaGovernor;

  constructor(client: MetaGraphClient, governor: MetaGovernor) {
    this.client = client;
    this.governor = governor;
  }

  async read(account: AdAccountRef, campaignId: string, accountId: string): Promise<CampaignStructure> {
    const campaign = await callWithGovernor(
      accountId,
      () =>
        this.client.request<RawCampaignNode>({
          method: "GET",
          path: campaignId,
          accessToken: account.accessToken,
          params: { fields: "name,objective,daily_budget,lifetime_budget,special_ad_categories" },
        }),
      { governor: this.governor },
    );

    const adsetsPage = await callWithGovernor(
      accountId,
      () =>
        this.client.request<{ data?: readonly RawAdSetNode[] }>({
          method: "GET",
          path: `${campaignId}/adsets`,
          accessToken: account.accessToken,
          params: {
            fields:
              "id,effective_status,daily_budget,lifetime_budget,optimization_goal,promoted_object{pixel_id,custom_event_type,custom_conversion_id,page_id},targeting{geo_locations,age_min,age_max,genders,custom_audiences,excluded_custom_audiences,flexible_spec,interests}",
            limit: COPY_STRUCTURE_ADSET_LIMIT,
          },
        }),
      { governor: this.governor },
    );
    const adsets = adsetsPage.data ?? [];
    // conjunto representativo (a cópia é 1-1-N): 1º ATIVO, senão o 1º.
    const source = adsets.find((a) => a.effective_status === ACTIVE_STATUS) ?? adsets[0];

    const adsPage = await callWithGovernor(
      accountId,
      () =>
        this.client.request<{ data?: readonly RawAdNode[] }>({
          method: "GET",
          path: `${campaignId}/ads`,
          accessToken: account.accessToken,
          params: { fields: "id,effective_status,creative{id}", limit: COPY_STRUCTURE_AD_LIMIT },
        }),
      { governor: this.governor },
    );
    const ads = adsPage.data ?? [];
    // ativos primeiro (a cópia reusa por referência); dedupe de creative_id.
    const ordered = [...ads].sort((a, b) => Number(b.effective_status === ACTIVE_STATUS) - Number(a.effective_status === ACTIVE_STATUS));
    const creativeRefs = [...new Set(ordered.map((a) => a.creative?.id).filter((id): id is string => !!id))];

    // CBO = orçamento na CAMPANHA; senão ABO (no conjunto).
    const campDaily = Number(campaign.daily_budget ?? 0);
    const campLifetime = Number(campaign.lifetime_budget ?? 0);
    const isCbo = campDaily > 0 || campLifetime > 0;
    const setDaily = Number(source?.daily_budget ?? 0);
    const setLifetime = Number(source?.lifetime_budget ?? 0);

    const objective =
      objectiveFromCampaign(campaign.objective)?.goal ??
      objectiveFromAdSet({
        ...(source?.optimization_goal ? { optimizationGoal: source.optimization_goal } : {}),
        ...(source?.promoted_object ? { promotedObject: source.promoted_object } : {}),
      })?.goal ??
      DEFAULT_CONVERSION_GOAL;

    const targeting = audienceFromTargeting(source?.targeting) ?? {
      stage: "unknown" as const,
      customAudienceCount: 0,
      exclusionCount: 0,
      expansion: { summary: "unknown" as const },
    };

    return {
      campaignId,
      name: campaign.name ?? campaignId,
      budgetMode: isCbo ? "cbo" : "abo",
      ...(isCbo ? (campDaily > 0 ? { dailyBudgetMinor: campDaily } : { lifetimeBudgetMinor: campLifetime }) : setDaily > 0 ? { dailyBudgetMinor: setDaily } : setLifetime > 0 ? { lifetimeBudgetMinor: setLifetime } : {}),
      objective,
      specialAdCategories: campaign.special_ad_categories ?? [],
      // pixel da fonte → threaded no createAdSet da cópia (senão conversão falha sem promoted_object).
      ...(source?.promoted_object?.pixel_id ? { pixelId: source.promoted_object.pixel_id } : {}),
      // Página de destino da fonte (`promoted_object.page_id`) → threaded no createAdSet da cópia. A Meta
      // EXIGE a Página no promoted_object de CONVERSAS (CTWA)/LEAD-sem-pixel; sem capturar aqui, a cópia
      // de campanha de conversas era recusada ("A Página é necessária no objeto promovido…").
      ...(source?.promoted_object?.page_id ? { pageId: source.promoted_object.page_id } : {}),
      sourceAdsetId: source?.id ?? "",
      targeting,
      creativeRefs,
    };
  }
}
