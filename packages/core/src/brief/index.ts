import type {
  AccountBrief,
  AdEntity,
  AgentGoals,
  Anomaly,
  CandidateAction,
  ConversionBreakdown,
  Creative,
  EntityLevel,
  EntityObjective,
  EntitySummary,
  InsightMetrics,
  InsightRow,
  TrendPoint,
} from "@trafego/shared";
import { resolveConversion, type ResolvedConversion } from "../conversion/index.js";

/**
 * Curadoria determinística PURA entre a Meta e o LLM (§7). O LLM nunca vê o
 * firehose: aqui reduzimos, ranqueamos e selecionamos. Pipeline:
 *   normalize → computeDerived → computeTrends → detectAnomalies →
 *   rankAndSelect → summarizeRest → selectCreatives → assembleBrief
 *
 * Este módulo cobre os passos puros de curadoria (assinaturas reais; partes
 * pesadas marcadas com TODO).
 */

// ─── normalize ────────────────────────────────────────────────────────────
/** Entidade agregada sobre a janela (soma das linhas diárias) — forma canônica. */
export interface NormalizedEntity {
  readonly entityId: string;
  readonly level: EntityLevel;
  readonly spend: number;
  readonly impressions: number;
  readonly clicks: number;
  readonly conversions: ConversionBreakdown;
}

/**
 * Agrega as linhas diárias por (nível, entidade), somando escalares e o breakdown
 * de conversões (por goal + id da personalizada). Forma canônica p/ computeDerived.
 */
export function normalize(rows: readonly InsightRow[]): NormalizedEntity[] {
  interface Acc {
    entityId: string;
    level: EntityLevel;
    spend: number;
    impressions: number;
    clicks: number;
    conv: Map<string, { goal: ConversionBreakdown[number]["goal"]; customConversionId?: string; count: number; value: number }>;
  }
  const byKey = new Map<string, Acc>();

  for (const row of rows) {
    const key = `${row.level}:${row.entityId}`;
    const acc =
      byKey.get(key) ??
      { entityId: row.entityId, level: row.level, spend: 0, impressions: 0, clicks: 0, conv: new Map() };
    acc.spend += row.metrics.spend ?? 0;
    acc.impressions += row.metrics.impressions ?? 0;
    acc.clicks += row.metrics.clicks ?? 0;
    for (const c of row.conversions ?? []) {
      const ck = `${c.goal}:${c.customConversionId ?? ""}`;
      const e =
        acc.conv.get(ck) ??
        { goal: c.goal, ...(c.customConversionId ? { customConversionId: c.customConversionId } : {}), count: 0, value: 0 };
      e.count += c.count;
      e.value += c.value ?? 0;
      acc.conv.set(ck, e);
    }
    byKey.set(key, acc);
  }

  return [...byKey.values()].map((a) => ({
    entityId: a.entityId,
    level: a.level,
    spend: a.spend,
    impressions: a.impressions,
    clicks: a.clicks,
    conversions: [...a.conv.values()].map((v) => ({
      goal: v.goal,
      ...(v.customConversionId ? { customConversionId: v.customConversionId } : {}),
      count: v.count,
      ...(v.value ? { value: v.value } : {}),
    })),
  }));
}

// ─── computeDerived ───────────────────────────────────────────────────────
/**
 * Deriva métricas de uma entidade agregada. CPA/ROAS usam a conversão **primária**
 * (o objetivo próprio da entidade; override do agente vence — `resolveConversion`),
 * casando por goal + id no breakdown. Sem conversão → julga por CPC/CPM (sem CPA).
 * Guarda divisão por zero.
 */
export function computeDerived(
  entity: NormalizedEntity,
  objective?: EntityObjective,
  override?: ResolvedConversion,
): InsightMetrics {
  const { spend, impressions, clicks } = entity;
  const ctr = impressions > 0 ? round((clicks / impressions) * 100, 4) : 0;
  const cpc = clicks > 0 ? round(spend / clicks, 4) : 0;
  const cpm = impressions > 0 ? round((spend / impressions) * 1000, 4) : 0;

  let conversions: number | undefined;
  let cpa: number | undefined;
  let roas: number | undefined;

  const resolved = resolveConversion(objective, override);
  if (resolved) {
    const match = entity.conversions.find(
      (c) =>
        c.goal === resolved.goal &&
        (resolved.customConversionId ? c.customConversionId === resolved.customConversionId : true),
    );
    conversions = match?.count ?? 0;
    if (match && match.count > 0) cpa = round(spend / match.count, 4);
    if (match && spend > 0 && match.value !== undefined) roas = round(match.value / spend, 4);
  }

  return {
    spend,
    impressions,
    clicks,
    ctr,
    cpc,
    cpm,
    ...(conversions !== undefined ? { conversions } : {}),
    ...(cpa !== undefined ? { cpa } : {}),
    ...(roas !== undefined ? { roas } : {}),
  };
}

// ─── computeTrends ────────────────────────────────────────────────────────
/** Agrega linhas diárias em pontos de tendência (uma entrada por data, com derivadas). */
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
      metrics: {
        spend: m.spend,
        impressions: m.impressions,
        clicks: m.clicks,
        ctr: m.impressions > 0 ? round((m.clicks / m.impressions) * 100, 4) : 0,
        cpc: m.clicks > 0 ? round(m.spend / m.clicks, 4) : 0,
        cpm: m.impressions > 0 ? round((m.spend / m.impressions) * 1000, 4) : 0,
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

// ─── summarizeRest ────────────────────────────────────────────────────────
/**
 * Resume a cauda longa (entidades NÃO selecionadas) em agregados — o LLM vê o topo
 * curado + este resumo, nunca o firehose. `avgCpa` só quando há CPA na cauda.
 */
export function summarizeRest(
  all: readonly EntitySummary[],
  selected: readonly EntitySummary[],
): AccountBrief["aggregatesRest"] {
  const selectedIds = new Set(selected.map((e) => e.id));
  const rest = all.filter((e) => !selectedIds.has(e.id));
  const spend = rest.reduce((s, e) => s + (e.metrics.spend ?? 0), 0);
  const cpas = rest
    .map((e) => e.metrics.cpa)
    .filter((x): x is number => typeof x === "number");
  return {
    count: rest.length,
    spend: round(spend, 2),
    ...(cpas.length > 0 ? { avgCpa: round(average(cpas), 2) } : {}),
  };
}

// ─── selectCreatives ──────────────────────────────────────────────────────
/**
 * Seleção de criativos p/ visão. Só faz sentido quando a análise de visão existe
 * (Fatia 3b, com `ANALYSIS_MAX_CREATIVES_VISION`); até lá, vazio. `getCreatives`
 * (capacidade) já existe no adapter (2a), mas não entra no brief ainda.
 */
export function selectCreatives(): Creative[] {
  return [];
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
  // creatives = seleção de visão (3b). Aqui é só composição das partes já curadas.
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

// ─── buildAccountBrief (orquestrador PURO) ────────────────────────────────
/**
 * Entrada do orquestrador — a casca (nó `fetchData`) já buscou entidades + linhas
 * (janela e baseline). O core NÃO faz IO: recebe tudo pronto e devolve o brief.
 */
export interface BuildAccountBriefInput {
  readonly account: { readonly id: string; readonly name: string; readonly currency: string };
  readonly window: string;
  readonly baselineWindow: string;
  readonly goals: AgentGoals;
  readonly entities: readonly AdEntity[];
  readonly rows: readonly InsightRow[];
  readonly baselineRows: readonly InsightRow[];
  readonly playbookCandidates: readonly CandidateAction[];
  readonly memory?: AccountBrief["memory"];
  readonly topN: number;
}

export type BuildAccountBriefResult =
  | { readonly status: "empty" }
  | { readonly status: "ok"; readonly brief: AccountBrief };

const SEGMENT_LEVELS = ["campaign", "adset", "ad"] as const;
const DELTA_METRICS = ["spend", "cpa", "roas", "ctr", "cpc"] as const;
const EMPTY_MEMORY: AccountBrief["memory"] = { objectives: [], pastActions: [], rejected: [] };

/**
 * Orquestra a curadoria pura: normalize → derived → EntitySummary (por nível) →
 * rankAndSelect (top-N + flagados) → summarizeRest → assembleBrief. Conta sem
 * atividade (sem gasto e sem impressões) → `status: "empty"` (a casca pula o LLM).
 * 3a-1 = mínimo: flags de meta (CPA/ROAS). Anomalia/escore composto/funil = 3a-2.
 */
export function buildAccountBrief(input: BuildAccountBriefInput): BuildAccountBriefResult {
  const entityById = new Map(input.entities.map((e) => [e.id, e]));
  const normalized = normalize(input.rows);
  const baselineByKey = new Map(
    normalize(input.baselineRows).map((n) => [`${n.level}:${n.entityId}`, n]),
  );

  const totals = computeAccountTotals(normalized, baselineByKey);
  if (totals.spend === 0 && totals.impressions === 0) return { status: "empty" };

  const selectedByLevel = new Map<EntityLevel, EntitySummary[]>();
  const allByLevel = new Map<EntityLevel, EntitySummary[]>();
  for (const level of SEGMENT_LEVELS) {
    const summaries = normalized
      .filter((n) => n.level === level)
      .map((n) => toEntitySummary(n, entityById, baselineByKey, input.goals));
    allByLevel.set(level, summaries);
    selectedByLevel.set(level, rankAndSelect(summaries, input.topN));
  }

  // Cauda = campanhas não selecionadas (nível primário; evita dupla-contagem entre níveis).
  const aggregatesRest = summarizeRest(
    allByLevel.get("campaign") ?? [],
    selectedByLevel.get("campaign") ?? [],
  );

  const brief = assembleBrief({
    account: { ...input.account, window: input.window, baselineWindow: input.baselineWindow },
    goals: input.goals,
    totals,
    trends: computeTrends([...input.rows]),
    campaigns: selectedByLevel.get("campaign") ?? [],
    adsets: selectedByLevel.get("adset") ?? [],
    ads: selectedByLevel.get("ad") ?? [],
    anomalies: [], // z-score no brief = 3a-2
    creatives: selectCreatives(), // visão = 3b
    playbookCandidates: input.playbookCandidates,
    memory: input.memory ?? EMPTY_MEMORY,
    aggregatesRest,
  });

  return { status: "ok", brief };
}

/** Totais da conta (nível `account`; sem CPA único enganoso p/ objetivos mistos). */
function computeAccountTotals(
  normalized: readonly NormalizedEntity[],
  baselineByKey: ReadonlyMap<string, NormalizedEntity>,
): AccountBrief["totals"] {
  const account = normalized.find((n) => n.level === "account");
  const current = account
    ? computeDerived(account)
    : { spend: 0, impressions: 0, clicks: 0, ctr: 0, cpc: 0, cpm: 0 };
  const base = account ? baselineByKey.get(`account:${account.entityId}`) : undefined;
  const delta = base ? deltaBetween(current, computeDerived(base)) : {};
  // totals = InsightMetrics & { delta }; o index signature de InsightMetrics
  // (`[k]: number|undefined`) exige o cast p/ o campo objeto `delta` (mesmo
  // padrão do brief.test.ts).
  return { ...current, delta } as AccountBrief["totals"];
}

/** Monta o `EntitySummary` de uma entidade (metrics + delta + flags de meta). */
function toEntitySummary(
  n: NormalizedEntity,
  entityById: ReadonlyMap<string, AdEntity>,
  baselineByKey: ReadonlyMap<string, NormalizedEntity>,
  goals: AgentGoals,
): EntitySummary {
  const entity = entityById.get(n.entityId);
  const metrics = computeDerived(n, entity?.objective);
  const base = baselineByKey.get(`${n.level}:${n.entityId}`);
  const baseMetrics = base ? computeDerived(base, entity?.objective) : undefined;
  return {
    id: n.entityId,
    level: n.level,
    name: entity?.name ?? n.entityId,
    status: entity?.status ?? "active",
    metrics,
    deltaVsBaseline: baseMetrics ? deltaBetween(metrics, baseMetrics) : {},
    flags: metaFlags(metrics, goals),
    ...(entity?.objective ? { objective: entity.objective } : {}),
  };
}

/** Flags mínimas (3a-1): desempenho vs meta do agente. */
function metaFlags(metrics: InsightMetrics, goals: AgentGoals): string[] {
  const flags: string[] = [];
  if (goals.targetCPA !== undefined && metrics.cpa !== undefined && metrics.cpa > goals.targetCPA) {
    flags.push("cpa_acima_da_meta");
  }
  if (goals.targetROAS !== undefined && metrics.roas !== undefined && metrics.roas < goals.targetROAS) {
    flags.push("roas_abaixo_da_meta");
  }
  return flags;
}

/** Delta (atual − baseline) só nas métricas comparáveis presentes nos dois lados. */
function deltaBetween(current: InsightMetrics, baseline: InsightMetrics): Partial<InsightMetrics> {
  const delta: Record<string, number> = {};
  for (const k of DELTA_METRICS) {
    const a = current[k];
    const b = baseline[k];
    if (typeof a === "number" && typeof b === "number") delta[k] = round(a - b, 4);
  }
  return delta;
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
