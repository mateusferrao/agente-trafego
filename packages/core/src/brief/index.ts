import type {
  AccountBrief,
  AgentGoals,
  Anomaly,
  CandidateAction,
  Creative,
  EntitySummary,
  InsightMetrics,
  InsightRow,
  TrendPoint,
} from "@trafego/shared";

/**
 * Curadoria determinística PURA entre a Meta e o LLM (§7). O LLM nunca vê o
 * firehose: aqui reduzimos, ranqueamos e selecionamos. Pipeline:
 *   normalize → computeDerived → computeTrends → detectAnomalies →
 *   rankAndSelect → summarizeRest → selectCreatives → assembleBrief
 *
 * Este módulo cobre os passos puros de curadoria (assinaturas reais; partes
 * pesadas marcadas com TODO).
 */

// ─── computeTrends ────────────────────────────────────────────────────────
/** Agrega linhas diárias em pontos de tendência (uma entrada por data). */
export function computeTrends(rows: InsightRow[]): TrendPoint[] {
  const byDate = new Map<string, { spend: number; impressions: number; clicks: number }>();

  for (const row of rows) {
    if (!row.date) continue; // sem data = agregado, não entra na série
    const acc = byDate.get(row.date) ?? { spend: 0, impressions: 0, clicks: 0 };
    acc.spend += row.metrics.spend ?? 0;
    acc.impressions += row.metrics.impressions ?? 0;
    acc.clicks += row.metrics.clicks ?? 0;
    byDate.set(row.date, acc);
  }

  return [...byDate.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, m]) => ({
      date,
      // TODO: computar derivadas (ctr, cpc, cpm, roas) por dia quando necessário
      metrics: {
        spend: m.spend,
        impressions: m.impressions,
        clicks: m.clicks,
      } as Partial<InsightMetrics>,
    }));
}

// ─── detectAnomalies (z-score) ────────────────────────────────────────────
/**
 * Detecta outliers por z-score em cada métrica pedida, entre entidades.
 * `|z| >= threshold` (default 2) vira `Anomaly`. Real e testável.
 */
export function detectAnomalies(
  rows: InsightRow[],
  metrics: readonly (keyof InsightMetrics)[] = ["cpa", "roas", "ctr", "spend"],
  threshold = 2,
): Anomaly[] {
  const anomalies: Anomaly[] = [];

  for (const metric of metrics) {
    const points = rows
      .map((r) => ({ entityId: r.entityId, value: r.metrics[metric] }))
      .filter((p): p is { entityId: string; value: number } => typeof p.value === "number");

    if (points.length < 3) continue; // amostra pequena → z-score não é confiável

    const values = points.map((p) => p.value);
    const mean = average(values);
    const sd = stdDev(values, mean);
    if (sd === 0) continue;

    for (const p of points) {
      const z = (p.value - mean) / sd;
      if (Math.abs(z) >= threshold) {
        anomalies.push({
          entityId: p.entityId,
          metric: String(metric),
          zScore: round(z, 2),
          note: `${String(metric)}=${p.value} desvia ${round(z, 1)}σ da média ${round(mean, 2)}`,
        });
      }
    }
  }

  return anomalies;
}

// ─── rankAndSelect ────────────────────────────────────────────────────────
/**
 * Seleciona top-N por spend + todas as entidades flagadas (união, sem
 * duplicar). Garante que anomalias entrem no brief mesmo com spend baixo.
 */
export function rankAndSelect(entities: EntitySummary[], topN: number): EntitySummary[] {
  const flagged = entities.filter((e) => e.flags.length > 0);
  const flaggedIds = new Set(flagged.map((e) => e.id));

  const topBySpend = entities
    .filter((e) => !flaggedIds.has(e.id))
    .slice()
    .sort((a, b) => (b.metrics.spend ?? 0) - (a.metrics.spend ?? 0))
    .slice(0, Math.max(0, topN));

  // TODO: escore composto (spend + delta vs baseline + severidade da flag)
  return [...flagged, ...topBySpend];
}

// ─── assembleBrief ────────────────────────────────────────────────────────
export interface AssembleBriefInput {
  readonly account: AccountBrief["account"];
  readonly goals: AgentGoals;
  readonly totals: AccountBrief["totals"];
  readonly trends: readonly TrendPoint[];
  readonly campaigns: readonly EntitySummary[];
  readonly adsets: readonly EntitySummary[];
  readonly ads: readonly EntitySummary[];
  readonly anomalies: readonly Anomaly[];
  readonly creatives: readonly Creative[];
  readonly playbookCandidates: readonly CandidateAction[];
  readonly memory: AccountBrief["memory"];
  readonly aggregatesRest: AccountBrief["aggregatesRest"];
}

/**
 * Monta o `AccountBrief` final (único input do LLM) a partir das partes já
 * curadas. Aqui é só composição; o trabalho pesado (summarizeRest,
 * selectCreatives com cap de visão) acontece nos passos anteriores.
 */
export function assembleBrief(input: AssembleBriefInput): AccountBrief {
  // TODO: aplicar ANALYSIS_MAX_CREATIVES_VISION (cap de custo de visão) —
  // selecionar só flagados com imagem confiável antes de montar.
  return {
    account: input.account,
    goals: input.goals,
    totals: input.totals,
    trends: input.trends,
    segments: {
      campaigns: input.campaigns,
      adsets: input.adsets,
      ads: input.ads,
    },
    anomalies: input.anomalies,
    creatives: input.creatives,
    playbookCandidates: input.playbookCandidates,
    memory: input.memory,
    aggregatesRest: input.aggregatesRest,
  };
}

// ─── helpers estatísticos ─────────────────────────────────────────────────
function average(xs: number[]): number {
  return xs.reduce((s, x) => s + x, 0) / xs.length;
}

function stdDev(xs: number[], mean: number): number {
  const variance = xs.reduce((s, x) => s + (x - mean) ** 2, 0) / xs.length;
  return Math.sqrt(variance);
}

function round(x: number, dp: number): number {
  const f = 10 ** dp;
  return Math.round(x * f) / f;
}
