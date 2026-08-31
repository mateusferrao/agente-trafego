// Curadoria PURA da árvore por campanha (S2) — entre o brief e o mapa por-campanha.
// Reduz a campanha a: adsets ativos + anúncios NOTÁVEIS (top-N por gasto/flag) +
// cauda agregada por adset. Sem IO; testável sem mock. Reusa `rankAndSelect`.

import type { AdEntity, CampaignAdsetGroup, CampaignUnit, CreativeVisionResult, EntitySummary } from "@trafego/shared";
import { detectCreativeWeakness } from "../quality/index.js";

export interface BuildCampaignUnitsInput {
  /** Summaries por nível (já com flags de meta/anomalia aplicadas). */
  readonly campaigns: readonly EntitySummary[];
  readonly adsets: readonly EntitySummary[];
  readonly ads: readonly EntitySummary[];
  /** Entidades cruas p/ os links de hierarquia (campaignId/adsetId). */
  readonly entityById: ReadonlyMap<string, AdEntity>;
  /** Teto de anúncios detalhados por campanha (resto vira cauda). */
  readonly notableAdsPerCampaign: number;
  /** Campanhas silenciadas pelo usuário (opt-out) — excluídas da análise. */
  readonly mutedCampaignIds?: ReadonlySet<string>;
}

/**
 * Monta uma `CampaignUnit` por campanha **ativa** (não silenciada): agrupa os
 * adsets/anúncios ativos pela hierarquia, seleciona os anúncios notáveis por
 * campanha (**teto duro** `notableAdsPerCampaign`: flagados priorizados, depois
 * maior gasto) e resume o resto numa cauda por adset. O teto é DURO — o excedente,
 * inclusive flagado, cai na cauda (senão uma campanha toda fora da meta estouraria
 * o contexto do LLM). Ordena por gasto (maior primeiro) p/ leitura estável.
 */
export function buildCampaignUnits(input: BuildCampaignUnitsInput): CampaignUnit[] {
  const muted = input.mutedCampaignIds ?? new Set<string>();
  const activeCampaigns = input.campaigns
    .filter((c) => c.status === "active" && !muted.has(c.id))
    .sort(bySpendDesc);

  const activeAdsets = input.adsets.filter((a) => a.status === "active");
  const activeAds = input.ads.filter((a) => a.status === "active");

  return activeCampaigns.map((campaign) => {
    const campaignAdsets = activeAdsets
      .filter((a) => input.entityById.get(a.id)?.campaignId === campaign.id)
      .sort(bySpendDesc);
    const adsetIds = new Set(campaignAdsets.map((a) => a.id));
    // Só anúncios cujo adset ATIVO está na árvore — não desperdiça slot de notável
    // com ad órfão (adset pausado/sem summary) que não seria renderizado.
    const renderableAds = activeAds.filter((ad) => {
      const e = input.entityById.get(ad.id);
      return e?.campaignId === campaign.id && e.adsetId !== undefined && adsetIds.has(e.adsetId);
    });

    // Notáveis escolhidos no nível da CAMPANHA com teto duro; distribuídos por adset.
    const notableIds = selectNotableAdIds(renderableAds, input.notableAdsPerCampaign);
    const adsets = campaignAdsets.map((adset) => buildAdsetGroup(adset, renderableAds, notableIds, input.entityById));
    return { campaign, adsets };
  });
}

/**
 * Ids dos anúncios notáveis de uma campanha, com **teto duro** `cap`: flagados
 * priorizados (fadiga/anomalia/fora da meta primeiro), depois maior gasto. O
 * excedente — inclusive flagado — fica de fora (vai pra cauda), garantindo prompt
 * de tamanho previsível mesmo numa campanha inteira fora da meta.
 */
function selectNotableAdIds(ads: readonly EntitySummary[], cap: number): Set<string> {
  const ranked = [...ads].sort((a, b) => {
    const fa = a.flags.length > 0 ? 1 : 0;
    const fb = b.flags.length > 0 ? 1 : 0;
    if (fa !== fb) return fb - fa; // flagados primeiro
    return (b.metrics.spend ?? 0) - (a.metrics.spend ?? 0); // depois por gasto
  });
  return new Set(ranked.slice(0, Math.max(0, cap)).map((a) => a.id));
}

function buildAdsetGroup(
  adset: EntitySummary,
  campaignAds: readonly EntitySummary[],
  notableIds: ReadonlySet<string>,
  entityById: ReadonlyMap<string, AdEntity>,
): CampaignAdsetGroup {
  const adsetAds = campaignAds.filter((ad) => entityById.get(ad.id)?.adsetId === adset.id);
  const notableAds = adsetAds.filter((ad) => notableIds.has(ad.id)).sort(bySpendDesc);
  const tailAds = adsetAds.filter((ad) => !notableIds.has(ad.id));
  return {
    adset,
    notableAds,
    tail: {
      count: tailAds.length,
      spend: round2(tailAds.reduce((s, ad) => s + (ad.metrics.spend ?? 0), 0)),
      allWithinTarget: tailAds.every((ad) => ad.flags.length === 0),
    },
  };
}

/**
 * Anexa `weak_creative` (S4b) aos anúncios NOTÁVEIS cuja visão resolvida indica prova fraca +
 * baixa persuasão (`detectCreativeWeakness`). Roda DEPOIS da visão resolver (a unidade já está
 * montada) — só enriquece `healthSignals`, dedup, preserva sinais já existentes. Ads sem visão
 * resolvida (miss/falha) saem intactos. Puro; nova árvore (não muta a `unit` recebida).
 */
export function attachCreativeWeaknessSignals(
  unit: CampaignUnit,
  visionByAdId: ReadonlyMap<string, readonly CreativeVisionResult[]>,
): CampaignUnit {
  const withWeakness = (ad: EntitySummary): EntitySummary => {
    const vision = visionByAdId.get(ad.id)?.[0];
    if (!vision) return ad;
    const weakness = detectCreativeWeakness(vision.proofStrength, vision.persuasionSignals);
    if (weakness.length === 0) return ad;
    const existing = ad.healthSignals ?? [];
    const merged = [...existing, ...weakness.filter((s) => !existing.includes(s))];
    return { ...ad, healthSignals: merged };
  };
  return {
    ...unit,
    adsets: unit.adsets.map((g) => ({ ...g, notableAds: g.notableAds.map(withWeakness) })),
  };
}

function bySpendDesc(a: EntitySummary, b: EntitySummary): number {
  return (b.metrics.spend ?? 0) - (a.metrics.spend ?? 0);
}

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}
