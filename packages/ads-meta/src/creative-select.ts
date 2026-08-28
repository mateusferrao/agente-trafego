// Seleção PURA do melhor criativo veiculando p/ reuso na criação (Fatia 7 — decisão A do
// dono: "escolher o melhor criativo veiculando pra recomendar/publicar"). Ranqueia os
// anúncios ATIVOS por desempenho de negócio (menor custo por resultado; sem resultados →
// maior gasto = investimento provado). Vocabulário Meta (action_type/effective_status) vive
// SÓ aqui no adapter; o core recebe defaults neutros. Testável sem rede.

/** Ação de insight crua da Graph (action_type + value acumulado). */
export interface RawInsightAction {
  readonly action_type?: string;
  readonly value?: string;
}

/** object_story_spec cru (imagem OU vídeo) — de onde extraímos copy + mídia. */
export interface RawObjectStorySpec {
  readonly page_id?: string;
  readonly link_data?: {
    readonly image_hash?: string;
    readonly link?: string;
    readonly message?: string;
    readonly name?: string;
    readonly description?: string;
  };
  readonly video_data?: {
    readonly video_id?: string;
    readonly message?: string;
    readonly title?: string;
    readonly link_description?: string;
    readonly image_url?: string;
    /** o link de destino do vídeo mora aqui (não em link_data) — CTA do object_story_spec. */
    readonly call_to_action?: { readonly value?: { readonly link?: string } };
  };
}

/** Anúncio candidato cru (campos pedidos no /ads). */
export interface RawAdCandidate {
  readonly id?: string;
  readonly effective_status?: string;
  readonly creative?: { readonly object_story_spec?: RawObjectStorySpec };
  readonly adset?: { readonly promoted_object?: { readonly pixel_id?: string } };
  readonly campaign?: { readonly objective?: string };
  readonly insights?: { readonly data?: ReadonlyArray<{ readonly spend?: string; readonly actions?: readonly RawInsightAction[] }> };
}

export interface RankedAd {
  readonly ad: RawAdCandidate;
  readonly spend: number;
  readonly results: number;
  /** custo por resultado (menor = melhor); `null` quando não há resultados. */
  readonly costPerResult: number | null;
}

/**
 * Tipos de ação que contam como RESULTADO de negócio (proxy neutro — cobre variações de
 * conversão/lead do pixel Meta). Fadiga: não é exaustivo, mas o suficiente pra distinguir
 * "tem resultado" de "só gasto". Objetivo específico da entidade não é conhecido aqui, então
 * usamos um conjunto amplo de conversões de fundo/meio de funil.
 */
const RESULT_ACTION_TYPES: ReadonlySet<string> = new Set([
  "purchase",
  "offsite_conversion.fb_pixel_purchase",
  "omni_purchase",
  "lead",
  "offsite_conversion.fb_pixel_lead",
  "onsite_conversion.lead_grouped",
  "complete_registration",
  "offsite_conversion.fb_pixel_complete_registration",
  "onsite_conversion.messaging_conversation_started_7d",
  "offsite_conversion.fb_pixel_add_to_cart",
]);

function num(v: string | undefined): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function metricsOf(ad: RawAdCandidate): { spend: number; results: number } {
  const row = ad.insights?.data?.[0];
  const spend = num(row?.spend);
  const results = (row?.actions ?? []).reduce(
    (sum, a) => (a.action_type && RESULT_ACTION_TYPES.has(a.action_type) ? sum + num(a.value) : sum),
    0,
  );
  return { spend, results };
}

/**
 * Ranqueia anúncios p/ reuso, MELHOR PRIMEIRO. Só ATIVOS (quando o status é conhecido);
 * se nenhum ativo, cai pra todos (cold-start reusa o que houver). Ordem: quem tem resultado
 * vence quem não tem; entre os com resultado, menor custo por resultado; entre os sem,
 * maior gasto (investimento provado). PURA.
 */
export function rankAdsForReuse(ads: readonly RawAdCandidate[]): RankedAd[] {
  const active = ads.filter((a) => a.effective_status === undefined || a.effective_status === "ACTIVE");
  const pool = active.length > 0 ? active : ads;
  const ranked: RankedAd[] = pool
    .filter((a) => Boolean(a.id))
    .map((ad) => {
      const { spend, results } = metricsOf(ad);
      return { ad, spend, results, costPerResult: results > 0 ? spend / results : null };
    });
  return ranked.sort((a, b) => {
    const aHas = a.costPerResult !== null;
    const bHas = b.costPerResult !== null;
    if (aHas !== bHas) return aHas ? -1 : 1; // com resultado primeiro
    if (aHas && bHas) return a.costPerResult! - b.costPerResult!; // menor CPR
    return b.spend - a.spend; // sem resultado: maior gasto
  });
}

/** Extrai copy (primaryText/headline) do object_story_spec (imagem ou vídeo). */
export function copyOf(ad: RawAdCandidate): { primaryText?: string; headline?: string } | null {
  const spec = ad.creative?.object_story_spec;
  const ld = spec?.link_data;
  const vd = spec?.video_data;
  const primaryText = ld?.message ?? vd?.message;
  const headline = ld?.name ?? vd?.title;
  if (!primaryText && !headline) return null;
  return { ...(primaryText ? { primaryText } : {}), ...(headline ? { headline } : {}) };
}
