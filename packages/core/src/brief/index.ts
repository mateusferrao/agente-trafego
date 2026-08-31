import type {
  AccountBrief,
  AdEntity,
  AgentGoals,
  Anomaly,
  CampaignUnit,
  CandidateAction,
  ConversionBasis,
  ConversionBreakdown,
  ConversionProxy,
  Creative,
  EntityLevel,
  EntityObjective,
  EntitySummary,
  FunnelBreakdown,
  FunnelSummary,
  InsightMetrics,
  InsightRow,
  OutcomeKind,
  PlatformQualityRankings,
  RangeBand,
  TrackingHealth,
  TrendPoint,
  WasteReport,
} from "@trafego/shared";
import { classifyBasis, resolveConversion, type ResolvedConversion } from "../conversion/index.js";
import { computeFunnelSummary, mergeFunnel } from "../funnel/index.js";
import type { CtrBands } from "../benchmarks/index.js";
import { DEFAULT_QUALITY_THRESHOLDS, type QualityThresholds, enrichEntitiesQuality } from "../quality/index.js";
import { detectTrackingHealth } from "../tracking/index.js";
import { computeWasteReport } from "../waste/index.js";
import { buildCampaignUnits } from "./campaign-units.js";
import { attachBudgetCeiling, type BudgetCeilingThresholds } from "../creation/budget-ceiling.js";

export { attachCreativeWeaknessSignals, buildCampaignUnits, type BuildCampaignUnitsInput } from "./campaign-units.js";

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
  /**
   * Frequência (impressões/alcance) — NÃO é somável entre dias (alcance é dedup).
   * Guardamos o MÁXIMO por entidade na janela: sinal honesto de "chegou a saturar".
   */
  readonly frequency?: number;
  /** Alcance (S6) — mesma razão de não-somável que frequência (pessoas ÚNICAS, dedup
   *  entre dias): guardamos o do ÚLTIMO dia da janela (proxy do alcance atual, não o
   *  acumulado do período — documentado como aproximação, CLAUDE.md §7). */
  readonly reach?: number;
  /** Cliques no link (S6) — evento discreto por dia, soma normalmente (como `clicks`). */
  readonly inlineLinkClicks?: number;
  /** Reproduções de vídeo a 25% (S6) — evento discreto por dia, soma normalmente. */
  readonly videoP25WatchedCount?: number;
  /** Rankings de qualidade da Meta (S6) — fato do dia, não somável; guardamos o do
   *  ÚLTIMO dia com dado reportado (mesma razão de `reach`). */
  readonly qualityRankings?: PlatformQualityRankings;
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
    frequency: number;
    inlineLinkClicks: number;
    videoP25WatchedCount: number;
    /** último dia visto com `reach`/`qualityRankings` — reach e rankings não são somáveis. */
    reachDate?: string;
    reach?: number;
    qualityRankingsDate?: string;
    qualityRankings?: PlatformQualityRankings;
    conv: Map<
      string,
      { goal: ConversionBreakdown[number]["goal"]; customConversionId?: string; count: number; value: number; hasValue: boolean }
    >;
  }
  const byKey = new Map<string, Acc>();

  for (const row of rows) {
    const key = `${row.level}:${row.entityId}`;
    const acc: Acc =
      byKey.get(key) ??
      {
        entityId: row.entityId,
        level: row.level,
        spend: 0,
        impressions: 0,
        clicks: 0,
        frequency: 0,
        inlineLinkClicks: 0,
        videoP25WatchedCount: 0,
        conv: new Map(),
      };
    acc.spend += row.metrics.spend ?? 0;
    acc.impressions += row.metrics.impressions ?? 0;
    acc.clicks += row.metrics.clicks ?? 0;
    acc.inlineLinkClicks += row.metrics.inlineLinkClicks ?? 0;
    acc.videoP25WatchedCount += row.metrics.videoP25WatchedCount ?? 0;
    if (typeof row.metrics.frequency === "number") {
      acc.frequency = Math.max(acc.frequency, row.metrics.frequency);
    }
    if (row.date !== undefined && row.metrics.reach !== undefined && (acc.reachDate === undefined || row.date >= acc.reachDate)) {
      acc.reachDate = row.date;
      acc.reach = row.metrics.reach;
    }
    if (row.date !== undefined && row.qualityRankings !== undefined && (acc.qualityRankingsDate === undefined || row.date >= acc.qualityRankingsDate)) {
      acc.qualityRankingsDate = row.date;
      acc.qualityRankings = row.qualityRankings;
    }
    for (const c of row.conversions ?? []) {
      const ck = `${c.goal}:${c.customConversionId ?? ""}`;
      const e =
        acc.conv.get(ck) ??
        { goal: c.goal, ...(c.customConversionId ? { customConversionId: c.customConversionId } : {}), count: 0, value: 0, hasValue: false };
      e.count += c.count;
      // distingue "valor 0 reportado" (receita zero → roas 0) de "conversão sem
      // dimensão de valor" (ex: messaging → sem roas). Só marca hasValue se veio valor.
      if (c.value !== undefined) {
        e.value += c.value;
        e.hasValue = true;
      }
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
    ...(a.frequency > 0 ? { frequency: a.frequency } : {}),
    // mesma convenção de `frequency` acima (>0 como proxy de presença — evento discreto,
    // zero genuíno é indistinguível de "campo não reportado" nesta agregação simples).
    ...(a.inlineLinkClicks > 0 ? { inlineLinkClicks: a.inlineLinkClicks } : {}),
    ...(a.videoP25WatchedCount > 0 ? { videoP25WatchedCount: a.videoP25WatchedCount } : {}),
    ...(a.reach !== undefined ? { reach: a.reach } : {}),
    ...(a.qualityRankings !== undefined ? { qualityRankings: a.qualityRankings } : {}),
    conversions: [...a.conv.values()].map((v) => ({
      goal: v.goal,
      ...(v.customConversionId ? { customConversionId: v.customConversionId } : {}),
      count: v.count,
      // preserva value=0 quando um valor FOI reportado (gasto com receita zero é sinal:
      // "gastando, sem retorno" → roas 0); omite quando a conversão não tem valor.
      ...(v.hasValue ? { value: v.value } : {}),
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

  // Receita rastreada TOTAL (todas as conversões com valor, ex.: compras) — contexto do
  // retorno mesmo quando o goal de negócio é conversa/lead (sem valor). Não muda cpa/roas
  // (que seguem o goal, §7); só EXPÕE a receita pro analista/chat não esconderem.
  const revenueTotal = entity.conversions.reduce((s, c) => s + (c.value ?? 0), 0);
  const revenue = entity.conversions.some((c) => c.value !== undefined) ? round(revenueTotal, 4) : undefined;

  // S6: retenção de vídeo nos primeiros 25% — aproximação (impressão ≈ tentativa de
  // reprodução em anúncio de vídeo; documentado, mesmo rigor do `deliveryEstimate`).
  const videoHookRetentionPct =
    entity.videoP25WatchedCount !== undefined && impressions > 0
      ? round((entity.videoP25WatchedCount / impressions) * 100, 4)
      : undefined;

  return {
    spend,
    impressions,
    clicks,
    ctr,
    cpc,
    cpm,
    ...(entity.frequency !== undefined ? { frequency: entity.frequency } : {}),
    ...(entity.reach !== undefined ? { reach: entity.reach } : {}),
    ...(entity.inlineLinkClicks !== undefined ? { inlineLinkClicks: entity.inlineLinkClicks } : {}),
    ...(entity.videoP25WatchedCount !== undefined ? { videoP25WatchedCount: entity.videoP25WatchedCount } : {}),
    ...(videoHookRetentionPct !== undefined ? { videoHookRetentionPct } : {}),
    ...(conversions !== undefined ? { conversions } : {}),
    ...(cpa !== undefined ? { cpa } : {}),
    ...(roas !== undefined ? { roas } : {}),
    ...(revenue !== undefined ? { revenue } : {}),
  };
}

// ─── computeTrends ────────────────────────────────────────────────────────
/**
 * Escolhe as linhas da série temporal: nível conta (uma linha/data, sem soma
 * entre níveis) e, se a conta não reportar por dia, cai p/ campanha. Evita a
 * dupla-contagem que infla o ponto quando todos os níveis compartilham a data.
 */
export function trendRows(rows: readonly InsightRow[]): InsightRow[] {
  const account = rows.filter((r) => r.level === "account");
  if (account.length > 0) return [...account];
  return rows.filter((r) => r.level === "campaign");
}

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
/** Peso do delta vs baseline no escore composto (spend é o termo dominante). */
const DELTA_WEIGHT = 0.5;

/** Magnitude do movimento vs baseline (soma dos |delta| das métricas). */
function deltaMagnitude(e: EntitySummary): number {
  return Object.values(e.deltaVsBaseline).reduce<number>(
    (s, v) => s + (typeof v === "number" ? Math.abs(v) : 0),
    0,
  );
}

/** Escore composto normalizado: spendShare + peso·deltaShare. */
function compositeScore(e: EntitySummary, maxSpend: number, maxDelta: number): number {
  return (e.metrics.spend ?? 0) / maxSpend + DELTA_WEIGHT * (deltaMagnitude(e) / maxDelta);
}

/**
 * Seleciona **todas as flagadas** (união, mesmo com spend baixo — anomalia/meta
 * sempre entra) + top-N das demais por **escore composto** (spend dominante +
 * delta vs baseline). Antes era só spend; agora quem se moveu também sobe.
 */
export function rankAndSelect(entities: EntitySummary[], topN: number): EntitySummary[] {
  const flagged = entities.filter((e) => e.flags.length > 0);
  const flaggedIds = new Set(flagged.map((e) => e.id));
  const rest = entities.filter((e) => !flaggedIds.has(e.id));

  const maxSpend = Math.max(1, ...entities.map((e) => e.metrics.spend ?? 0));
  const maxDelta = Math.max(1, ...entities.map(deltaMagnitude));

  const topByScore = rest
    .slice()
    .sort((a, b) => compositeScore(b, maxSpend, maxDelta) - compositeScore(a, maxSpend, maxDelta))
    .slice(0, Math.max(0, topN));

  return [...flagged, ...topByScore];
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
  readonly funnel?: FunnelSummary;
  readonly trackingHealth?: TrackingHealth;
  readonly waste?: WasteReport;
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
    ...(input.funnel ? { funnel: input.funnel } : {}),
    ...(input.trackingHealth ? { trackingHealth: input.trackingHealth } : {}),
    ...(input.waste ? { waste: input.waste } : {}),
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
  /** tamanho da janela em dias (P1.2) — normaliza `metrics.spend` (somado na janela) pra gasto
   *  médio/dia no sinal de teto de budget. Mesmo valor que gerou `window`/`rows`. */
  readonly windowDays: number;
  readonly baselineWindow: string;
  readonly goals: AgentGoals;
  readonly entities: readonly AdEntity[];
  readonly rows: readonly InsightRow[];
  readonly baselineRows: readonly InsightRow[];
  readonly playbookCandidates: readonly CandidateAction[];
  readonly memory?: AccountBrief["memory"];
  readonly topN: number;
  /** Teto de anúncios detalhados por campanha na árvore curada (S2). */
  readonly notableAdsPerCampaign: number;
  /** Campanhas silenciadas pelo usuário (S5) — excluídas da análise por campanha. */
  readonly mutedCampaignIds?: ReadonlySet<string>;
  /** Limiares de qualidade (Fatia 6c) — default do sistema se ausente. */
  readonly qualityThresholds?: QualityThresholds;
  /** Faixas de custo já resolvidas na moeda da conta (ausente = não injeta custo). */
  readonly costTable?: Partial<Record<OutcomeKind, RangeBand>>;
  /** Bandas de CTR override (senão default de plataforma). */
  readonly ctrBands?: CtrBands;
  /** Frequência de alerta override (senão default de plataforma). */
  readonly frequencyAlert?: number;
  /** Limiares do sinal de teto de budget (P1.2) — default do sistema se ausente. */
  readonly budgetCeilingThresholds?: BudgetCeilingThresholds;
}

export type BuildAccountBriefResult =
  | { readonly status: "empty" }
  | {
      readonly status: "ok";
      readonly brief: AccountBrief;
      /** TODAS as unidades de anúncio (não só o top-N do brief) — base do map-reduce (3b-2). */
      readonly adUnits: readonly EntitySummary[];
      /** Árvore curada por campanha ATIVA — base do map-reduce por-campanha (S2). */
      readonly campaignUnits: readonly CampaignUnit[];
    };

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
  const funnelByKey = buildFunnelByKey(input.rows);

  const totals = computeAccountTotals(normalized, baselineByKey, input.goals);
  if (totals.spend === 0 && totals.impressions === 0) return { status: "empty" };

  const selectedByLevel = new Map<EntityLevel, EntitySummary[]>();
  const allByLevel = new Map<EntityLevel, EntitySummary[]>();
  const anomalies: Anomaly[] = [];
  for (const level of SEGMENT_LEVELS) {
    const base = normalized
      .filter((n) => n.level === level)
      .map((n) => toEntitySummary(n, entityById, baselineByKey, funnelByKey, input.goals));
    // Anomalias (z-score) dentro do nível → viram flag (rankAndSelect sempre inclui flagado).
    const levelAnomalies = detectAnomaliesFromSummaries(base);
    anomalies.push(...levelAnomalies);
    const flagged = applyAnomalyFlags(base, levelAnomalies);
    // Qualidade (Fatia 6c): tiers/sinais/elegibilidade/benchmark de cold-start,
    // relativos à meta + à conta (ranking dentro do nível). Puro.
    const summaries = enrichEntitiesQuality(flagged, input.goals, {
      thresholds: input.qualityThresholds ?? DEFAULT_QUALITY_THRESHOLDS,
      hasTarget: input.goals.targetCPA !== undefined || input.goals.targetROAS !== undefined,
      currency: input.account.currency,
      ...(input.goals.conversionGoal ? { conversionGoal: input.goals.conversionGoal } : {}),
      ...(input.costTable ? { costTable: input.costTable } : {}),
      ...(input.ctrBands ? { ctrBands: input.ctrBands } : {}),
      ...(input.frequencyAlert !== undefined ? { frequencyAlert: input.frequencyAlert } : {}),
    });
    allByLevel.set(level, summaries);
    selectedByLevel.set(level, rankAndSelect(summaries, input.topN));
  }

  // Sinal de teto de budget (P1.2) — pós-loop porque agrega CAMPANHA×ADSET (ABO), então
  // precisa dos DOIS níveis já prontos. Re-deriva a seleção de campanha (o topN roda de novo
  // sobre a lista com `atBudgetCeiling` anexado — ranking em si não muda, o campo é aditivo).
  const campaignsWithCeiling = attachBudgetCeiling({
    campaigns: allByLevel.get("campaign") ?? [],
    adsets: allByLevel.get("adset") ?? [],
    windowDays: input.windowDays,
    ...(input.budgetCeilingThresholds ? { thresholds: input.budgetCeilingThresholds } : {}),
  });
  allByLevel.set("campaign", campaignsWithCeiling);
  selectedByLevel.set("campaign", rankAndSelect(campaignsWithCeiling, input.topN));

  // Cauda = campanhas não selecionadas (nível primário; evita dupla-contagem entre níveis).
  const aggregatesRest = summarizeRest(
    allByLevel.get("campaign") ?? [],
    selectedByLevel.get("campaign") ?? [],
  );

  // Funil da conta (nível account; qualidade do lead — secundário).
  const accountFunnel = computeFunnelSummary(
    mergeFunnel(input.rows.filter((r) => r.level === "account").map((r) => r.funnel ?? [])),
  );

  // Saúde da medição (§Bloco 2): muito funil × pouca conversão de negócio rastreada.
  const qt = input.qualityThresholds ?? DEFAULT_QUALITY_THRESHOLDS;
  const trackingHealth = detectTrackingHealth({
    ...(input.goals.conversionGoal ? { conversionGoal: input.goals.conversionGoal } : {}),
    funnelStarted: accountFunnel?.counts.conversation_started ?? 0,
    trackedConversions: totals.conversions ?? 0,
    thresholds: { ratio: qt.trackingBrokenRatio, minFunnel: qt.trackingBrokenMinFunnel },
  });

  // Desperdício + Pareto (§Bloco 2) sobre o conjunto COMPLETO de campanhas.
  const waste = computeWasteReport(allByLevel.get("campaign") ?? []);

  const brief = assembleBrief({
    account: { ...input.account, window: input.window, baselineWindow: input.baselineWindow },
    goals: input.goals,
    totals,
    // série temporal só do nível conta (fallback campanha) — somar todos os níveis
    // (account+campaign+adset+ad compartilham a data) infla o ponto ~4× e diverge
    // dos `totals`, que isolam o nível conta. O brief é o gabarito do LLM → tem de bater.
    trends: computeTrends(trendRows(input.rows)),
    campaigns: selectedByLevel.get("campaign") ?? [],
    adsets: selectedByLevel.get("adset") ?? [],
    ads: selectedByLevel.get("ad") ?? [],
    anomalies,
    ...(accountFunnel ? { funnel: accountFunnel } : {}),
    ...(trackingHealth ? { trackingHealth } : {}),
    ...(waste ? { waste } : {}),
    // visão entra por-unidade no map-reduce (3b-2), não no brief da conta. Reconsiderado no
    // pivô saúde (S8, "síntese ganha creatives agregados"): o campo é `Creative[]` (asset cru,
    // sem tier/score) — não existe hoje um agregado estruturado que caiba aqui sem duplicar
    // o que as narrativas por-campanha (unitAnalyses) já carregam pra síntese. Fica [] até
    // haver um agregado real de criativo pra propor (fast-follow, não confirmado ainda).
    creatives: [],
    playbookCandidates: input.playbookCandidates,
    memory: input.memory ?? EMPTY_MEMORY,
    aggregatesRest,
  });

  const campaignUnits = buildCampaignUnits({
    campaigns: allByLevel.get("campaign") ?? [],
    adsets: allByLevel.get("adset") ?? [],
    ads: allByLevel.get("ad") ?? [],
    entityById,
    notableAdsPerCampaign: input.notableAdsPerCampaign,
    ...(input.mutedCampaignIds ? { mutedCampaignIds: input.mutedCampaignIds } : {}),
  });

  return { status: "ok", brief, adUnits: allByLevel.get("ad") ?? [], campaignUnits };
}

export interface LiveTotalsInput {
  readonly rows: readonly InsightRow[];
  readonly baselineRows: readonly InsightRow[];
  readonly goals: AgentGoals;
}

/**
 * Totais da conta AO VIVO (6a): MESMA cadeia do brief (`normalize` →
 * `computeAccountTotals`), sem LLM nem catálogo de entidades — só a série do
 * `insights_snapshots`. Reusa exatamente o cálculo da análise (os números batem).
 * `null` quando não há atividade (spend+impressions = 0), p/ a casca mostrar vazio.
 */
export function computeLiveTotals(input: LiveTotalsInput): AccountBrief["totals"] | null {
  const normalized = normalize(input.rows);
  const baselineByKey = new Map(
    normalize(input.baselineRows).map((n) => [`${n.level}:${n.entityId}`, n]),
  );
  const totals = computeAccountTotals(normalized, baselineByKey, input.goals);
  if (totals.spend === 0 && totals.impressions === 0) return null;
  return totals;
}

/** Agrega o funil neutro por `nível:entidade` a partir das linhas (soma dias). */
function buildFunnelByKey(rows: readonly InsightRow[]): Map<string, FunnelBreakdown> {
  const byKey = new Map<string, FunnelBreakdown[]>();
  for (const row of rows) {
    if (!row.funnel || row.funnel.length === 0) continue;
    const key = `${row.level}:${row.entityId}`;
    (byKey.get(key) ?? byKey.set(key, []).get(key)!).push(row.funnel);
  }
  return new Map([...byKey].map(([key, list]) => [key, mergeFunnel(list)]));
}

/** Roda z-score sobre as métricas agregadas por entidade (não linhas diárias). */
function detectAnomaliesFromSummaries(summaries: readonly EntitySummary[]): Anomaly[] {
  const pseudoRows: InsightRow[] = summaries.map((e) => ({
    entityId: e.id,
    level: e.level,
    metrics: e.metrics,
  }));
  return detectAnomalies(pseudoRows);
}

/** Adiciona a flag `anomalia:<metric>` às entidades com outlier detectado. */
function applyAnomalyFlags(
  summaries: readonly EntitySummary[],
  anomalies: readonly Anomaly[],
): EntitySummary[] {
  const flagsById = new Map<string, string[]>();
  for (const a of anomalies) {
    const list = flagsById.get(a.entityId) ?? [];
    list.push(`anomalia:${a.metric}`);
    flagsById.set(a.entityId, list);
  }
  return summaries.map((e) => {
    const extra = flagsById.get(e.id);
    return extra ? { ...e, flags: [...e.flags, ...extra] } : e;
  });
}

/**
 * Totais da conta (nível `account`). Sem conversão de negócio → sem CPA único
 * (evita média enganosa entre objetivos mistos). COM conversão de negócio
 * (`goals.conversionGoal`) e eventos dela na conta → custo-por-venda da conta
 * (o KPI que o dono tem na cabeça); senão CPA fica ausente (nunca proxy no total).
 */
function computeAccountTotals(
  normalized: readonly NormalizedEntity[],
  baselineByKey: ReadonlyMap<string, NormalizedEntity>,
  goals: AgentGoals,
): AccountBrief["totals"] {
  const override = businessOverride(goals);
  const account = normalized.find((n) => n.level === "account");
  const current = account
    ? computeDerived(account, undefined, override)
    : { spend: 0, impressions: 0, clicks: 0, ctr: 0, cpc: 0, cpm: 0 };
  const base = account ? baselineByKey.get(`account:${account.entityId}`) : undefined;
  const delta = base ? deltaBetween(current, computeDerived(base, undefined, override)) : {};
  // totals = InsightMetrics & { delta }; o index signature de InsightMetrics
  // (`[k]: number|undefined`) exige o cast p/ o campo objeto `delta` (mesmo
  // padrão do brief.test.ts).
  return { ...current, delta } as AccountBrief["totals"];
}

/** Monta o `EntitySummary` de uma entidade (metrics + delta + basis/proxy + flags). */
function toEntitySummary(
  n: NormalizedEntity,
  entityById: ReadonlyMap<string, AdEntity>,
  baselineByKey: ReadonlyMap<string, NormalizedEntity>,
  funnelByKey: ReadonlyMap<string, FunnelBreakdown>,
  goals: AgentGoals,
): EntitySummary {
  const entity = entityById.get(n.entityId);
  const objective = entity?.objective;
  const override = businessOverride(goals);
  // CPA/ROAS medidos contra a conversão de NEGÓCIO (override vence o objetivo).
  const metrics = computeDerived(n, objective, override);
  const base = baselineByKey.get(`${n.level}:${n.entityId}`);
  const baseMetrics = base ? computeDerived(base, objective, override) : undefined;
  const funnel = computeFunnelSummary(funnelByKey.get(`${n.level}:${n.entityId}`) ?? []);
  const { basis, proxy } = resolveBasis(n, objective, override, metrics);
  // budget resolvido (P1.2) — CBO/próprio; ABO agrega via `campaignId` em `attachBudgetCeiling`.
  const hasBudget = entity?.dailyBudget !== undefined || entity?.lifetimeBudget !== undefined;
  const budget = hasBudget
    ? {
        ...(entity?.dailyBudget !== undefined ? { dailyMajor: entity.dailyBudget } : {}),
        ...(entity?.lifetimeBudget !== undefined ? { lifetimeMajor: entity.lifetimeBudget } : {}),
        ...(entity?.budgetRemaining !== undefined ? { lifetimeRemainingMajor: entity.budgetRemaining } : {}),
      }
    : undefined;
  return {
    id: n.entityId,
    level: n.level,
    name: entity?.name ?? n.entityId,
    status: entity?.status ?? "active",
    metrics,
    deltaVsBaseline: baseMetrics ? deltaBetween(metrics, baseMetrics) : {},
    flags: metaFlags(metrics, goals, basis),
    conversionBasis: basis,
    ...(objective ? { objective } : {}),
    ...(entity?.audience ? { audience: entity.audience } : {}),
    ...(proxy ? { proxy } : {}),
    ...(funnel ? { funnel } : {}),
    ...(entity?.campaignId ? { campaignId: entity.campaignId } : {}),
    ...(budget ? { budget } : {}),
    ...(entity?.bidStrategy ? { bidStrategy: entity.bidStrategy } : {}),
    ...(entity?.bidCapMajor !== undefined ? { bidCapMajor: entity.bidCapMajor } : {}),
    ...(n.qualityRankings ? { qualityRankings: n.qualityRankings } : {}),
  };
}

/** A conversão de NEGÓCIO do agente como override (§Fatia 4). Ausente = zero-config. */
function businessOverride(goals: AgentGoals): ResolvedConversion | undefined {
  if (!goals.conversionGoal) return undefined;
  return {
    goal: goals.conversionGoal,
    ...(goals.customConversionId ? { customConversionId: goals.customConversionId } : {}),
  };
}

/**
 * Classifica a base de medição da entidade vs a conversão de negócio:
 *  - CPA mensurável (override casou, ou sem override) → `target`.
 *  - override definido mas não mensurável aqui, com objetivo próprio mensurável →
 *    `proxy` (expõe a métrica do objetivo da entidade, rotulável, nunca "meta batida").
 *  - senão → `none` (julga por CPC/CPM).
 */
function resolveBasis(
  n: NormalizedEntity,
  objective: EntityObjective | undefined,
  override: ResolvedConversion | undefined,
  metrics: InsightMetrics,
): { basis: ConversionBasis; proxy?: ConversionProxy } {
  // objetivo próprio da entidade (sem override) — só p/ o proxy; computado sob demanda.
  const proxyMetrics = override && objective ? computeDerived(n, objective) : undefined;
  return classifyBasis({
    businessMetrics: metrics,
    hasOverride: override !== undefined,
    ...(objective ? { objective } : {}),
    ...(proxyMetrics ? { proxyMetrics } : {}),
  });
}

/**
 * Mapa de resolução da conversão de NEGÓCIO por entidade (`${level}:${id}` →
 * {basis, métricas de negócio}), p/ o playbook seguir o basis (§7 — só dispara CPA/
 * ROAS onde a conversão de negócio é mensurável). Reusa a MESMA classificação do
 * brief (`classifyBasis`) — fonte única, zero divergência.
 */
export function buildEntityConversionMap(
  rows: readonly InsightRow[],
  entities: readonly AdEntity[],
  goals: AgentGoals,
): Map<string, { basis: ConversionBasis; metrics: InsightMetrics }> {
  const entityById = new Map(entities.map((e) => [e.id, e]));
  const override = businessOverride(goals);
  const out = new Map<string, { basis: ConversionBasis; metrics: InsightMetrics }>();
  for (const n of normalize(rows)) {
    const objective = entityById.get(n.entityId)?.objective;
    const metrics = computeDerived(n, objective, override);
    const proxyMetrics = override && objective ? computeDerived(n, objective) : undefined;
    const { basis } = classifyBasis({
      businessMetrics: metrics,
      hasOverride: override !== undefined,
      ...(objective ? { objective } : {}),
      ...(proxyMetrics ? { proxyMetrics } : {}),
    });
    out.set(`${n.level}:${n.entityId}`, { basis, metrics });
  }
  return out;
}

/**
 * Flags mínimas (3a-1): desempenho vs meta do agente. Só compara meta quando o
 * basis é `target` — em `proxy`/`none` a CPA medida NÃO é a conversão de negócio,
 * então declarar meta (batida ou furada) seria comparar maçãs com laranjas.
 */
function metaFlags(metrics: InsightMetrics, goals: AgentGoals, basis: ConversionBasis): string[] {
  const flags: string[] = [];
  if (basis !== "target") return flags;
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
