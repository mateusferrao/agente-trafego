// Camada de LEITURA do agente conversacional (Grafo B) — Fatia 5b-2.2.
//
// Estas tools NÃO falam com a Meta: leem SÓ o NOSSO DB curado (último run,
// snapshots de insights, análises por entidade, recomendações, aprovações
// pendentes). Toda query é org-scoped. Nada re-deriva CPA/ROAS — o número
// exibido vem já curado do run/análise (o worker de análise é a fonte).
//
// Cada tool devolve uma STRING (JSON compacto) que o modelo lê. Respostas com
// métrica carregam `asOf` (frescor); a ausência de dado vira um sinal explícito
// (`hasData:false` + nota) p/ o agente recusar com clareza.

import { and, desc, eq, gte, inArray, isNotNull, sql } from "drizzle-orm";
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { adAccounts, adCreatives, agentMemory, agentRuns, agentToolCalls, agents, campaignDrafts, customAudiences, entityAnalyses, insightsSnapshots, recommendations } from "@trafego/db";
import type { Database } from "@trafego/db/client";
import { confidenceTier, daysAgoInTz, LEARNING_MEMORY_TYPES, rankAdCreatives, renderRessalvas, resolveNamedMatch, todayInTz, type RankableCreative } from "@trafego/core";
import { mapStatus } from "@trafego/ads-meta";
import { createAnalysisRepo, type AdCreativeCopyRow } from "../../modules/analysis/repo.js";
import {
  aggregateKpis,
  attributionCaveat,
  getAdsBreakdownData,
  getCampaignsBreakdownData,
  getFreshMetricsData,
  loadBusinessGoal,
  type FreshAdsBreakdown,
  type FreshKpis,
} from "../../modules/conversation/fresh-metrics.js";
import { describeCreatedDraft } from "../../modules/apply/draft-summary.js";
import type { ActivationApproval, Approval, ApprovalPort } from "@trafego/shared/ports";
import { UNDO_BLOCKED_TOOL_KEY, UNDO_TOOL_KEY, withTimeout } from "@trafego/shared";
import { ACCOUNT_HEALTH_STATUS_LABELS } from "@trafego/shared";
import type { AgentId, CampaignDraftSpec, CreativeAssetRef, CuratedEntitySnapshot, CustomAudience, DraftKind, EntityLevel, InsightMetrics, MetaAccountHealthStatus, OrgId, PartialReason, TargetingSpec, UnitAnalysis, WhatsappDestination } from "@trafego/shared";
import type { DraftApproval } from "@trafego/shared/ports";
import type { StoredInsightMetrics } from "@trafego/shared/types";
import type { WorkerDeps } from "../../composition.js";

/** Contexto do turno (tenant/conta resolvidos no início) — injetado nas tools. */
export interface ReadToolContext {
  readonly orgId: string;
  readonly agentId: string;
  readonly adAccountId: string;
  /** Fuso da org (orgs.timezone, fallback ANALYSIS_TZ) — datas de "hoje"/janela nele, não UTC. */
  readonly timezone: string;
}

/** Janela default do gasto agregado (dias). */
const DEFAULT_METRICS_PERIOD_DAYS = 7;
/** Runs "finalizados" que contam como a última análise concluída (mirror da API). */
const FINISHED_RUN_STATUSES = ["succeeded", "failed"] as const;
/** Nível mais alto do gasto agregado; cai p/ campanha quando não há linha de conta. */
const ACCOUNT_LEVEL: EntityLevel = "account";
const CAMPAIGN_LEVEL: EntityLevel = "campaign";
const ADSET_LEVEL: EntityLevel = "adset";
/** Mínimo de conjuntos com diagnóstico próprio pra expor a quebra por-adset (espelha S8b —
 *  só ABO com 2+ adsets ativos ganha achado por-adset; 0/1 não vale a pena expor separado). */
const MIN_ADSETS_FOR_BREAKDOWN = 2;
/** Explica a assimetria CBO×ABO no chat (CLAUDE.md §13 — nunca deixar parecer inconsistência). */
const ADSET_BREAKDOWN_NOTE =
  "esta campanha usa orçamento por conjunto de anúncios (ABO), não um orçamento único — por isso " +
  "cada conjunto tem diagnóstico e tier próprios, em vez de um só pra campanha inteira.";
/** Marcador de frescor quando não há nenhum snapshot no período. */
const ASOF_NONE = "sem dados";
/** Janela e teto do "desfaz isso" (ações recentes revertíveis). */
const RECENT_ACTIONS_DAYS = 7;
const RECENT_ACTIONS_LIMIT = 10;
/** Janela default da tendência de gasto por entidade. */
const ENTITY_TREND_DAYS = 14;
/** Teto de contas com DETALHE no panorama — WhatsApp não é lugar de parede de texto (chatRules). */
const PORTFOLIO_OVERVIEW_MAX_ACCOUNTS = 8;

// ─── Formas de saída (curadas p/ o modelo) ──────────────────────────────────
interface NoData {
  readonly hasData: false;
  readonly note: string;
}

/** Resumo do desperdício p/ o chat LIDERAR pelo dinheiro (§Bloco 2 money-shot). */
interface AccountWaste {
  /** gasto queimado em campanhas paradas (zumbis) — pausar libera esse valor. */
  readonly wastedSpend: number;
  readonly wastedPct: number;
  /** até 2 campanhas mal alocadas (gasto alto × resultado baixo). */
  readonly misallocated?: readonly { name: string | null; spendPct: number; resultPct?: number }[];
}

interface AccountStatus {
  readonly grade: string | null;
  readonly headline: string | null;
  readonly summary: string | null;
  readonly spend?: number;
  /** money-shot: quanto está sendo queimado e onde (§Bloco 2). Ausente = nada material. */
  readonly waste?: AccountWaste;
  readonly recommendationCount: number;
  readonly pendingCount: number;
  readonly asOf: string;
  /** honestidade sobre completude (sincronização/rate-limit) — ausente = análise íntegra. */
  readonly partialNote?: string;
}

interface AccountMetrics extends FreshKpis {
  readonly periodDays: number;
  readonly asOf: string;
  readonly hasData: true;
  /** presente quando o dado somado toca os últimos 7 dias — número ainda pode subir (atribuição). */
  readonly attributionNote?: string;
}

/** Sem snapshot no período (nem sync ainda rodou pra essa janela). */
interface NoAccountMetrics {
  readonly periodDays: number;
  readonly spend: number;
  readonly asOf: string;
  readonly hasData: false;
}

/**
 * Snapshot curado exposto ao chat (S1: budget/tier/isCBO — fecha o bug de o agente não saber
 * informar orçamento por campanha; S8: resto do `CuratedEntitySnapshot` — healthSignals/
 * audience/funnel/basis/benchmarkRef, o que faltava pro agente citar o MESMO diagnóstico que
 * o run já produziu, sem reler o brief). Projeção de `CuratedEntitySnapshot`; tudo null/undefined
 * nas linhas de antes de cada fase (backfill não retroativo).
 */
interface CuratedView {
  readonly tier: string | null;
  readonly budget: CuratedEntitySnapshot["budget"] | null;
  /** true = sem folga pra gastar mais sem subir o orçamento; false = tem folga; null = sem dado. */
  readonly atBudgetCeiling: boolean | null;
  /** true = orçamento na PRÓPRIA campanha (CBO); false = por conjunto/adset (ABO); null = sem dado. */
  readonly isCBO: boolean | null;
  readonly healthSignals: CuratedEntitySnapshot["healthSignals"];
  readonly audience: CuratedEntitySnapshot["audience"];
  readonly funnel: CuratedEntitySnapshot["funnel"];
  /** honestidade da conversão (Fatia 4) — 'target'/'proxy'/'none', ver `MISMATCH_TEXT`. */
  readonly conversionBasis: CuratedEntitySnapshot["conversionBasis"];
  readonly benchmarkRef: CuratedEntitySnapshot["benchmarkRef"];
  /** sincronização (achado real): presente = a Meta não lista mais esta campanha como ativa
   *  desde esta data (ISO) — o resto do curado (tier/métricas) é da ÚLTIMA vez que ela esteve
   *  ativa, NÃO reflete o estado atual. null = ainda ativa (ou nunca esteve, backfill). */
  readonly deactivatedSince: string | null;
}
/** Reasons que tornam o DADO da análise incompleto (grave — o dono precisa saber que os
 *  números podem estar sub-representados), vs. enriquecimento degradado (menos grave). */
const SEVERE_PARTIAL_REASONS = new Set<PartialReason>(["metrics", "entities"]);

/**
 * Traduz `agent_runs.partial_reasons` numa frase honesta pro chat (sincero sobre
 * sincronização/completude — mesmo princípio do `asOf`/cache: o dono nunca deve achar que
 * viu tudo quando na verdade a Meta limitou/uma parte degradou). `null` = análise íntegra,
 * nada a avisar. Pura — sem IO, testável direto.
 */
export function describePartialRun(reasons: readonly PartialReason[]): string | null {
  if (reasons.length === 0) return null;
  const severe = reasons.some((r) => SEVERE_PARTIAL_REASONS.has(r));
  if (severe) {
    return "Essa análise ficou INCOMPLETA — a Meta limitou temporariamente (rate-limit) e nem todas as campanhas/métricas entraram nela. Os números podem estar sub-representados; se algo parecer estranho ou faltando, ofereça rodar uma análise nova.";
  }
  if (reasons.includes("action_apply")) {
    return "Uma das ações desta análise falhou ao aplicar — o resto da análise (métricas/recomendações) está íntegro.";
  }
  return "Essa análise teve uma parte do enriquecimento degradada (ex: revisão automática ou leitura de criativo) — as métricas e recomendações principais estão íntegras, mas alguns detalhes podem faltar.";
}

function curatedViewOf(curated: CuratedEntitySnapshot | null): CuratedView {
  return {
    tier: curated?.tier ?? null,
    budget: curated?.budget ?? null,
    atBudgetCeiling: curated?.atBudgetCeiling ?? null,
    isCBO: curated?.isCBO ?? null,
    healthSignals: curated?.healthSignals,
    audience: curated?.audience,
    funnel: curated?.funnel,
    conversionBasis: curated?.conversionBasis,
    benchmarkRef: curated?.benchmarkRef,
    deactivatedSince: curated?.deactivatedSince ?? null,
  };
}

/** Diagnóstico de UM conjunto (adset) dentro de uma campanha ABO multi-adset (S8b/S8). */
interface AdsetBreakdownItem {
  readonly id: string;
  readonly name: string | null;
  readonly tier: string | null;
}

interface CampaignAnalysis extends CuratedView {
  /** id da campanha na plataforma — o agente usa p/ agir (pausar/budget) no chat (5c). */
  readonly id: string;
  readonly name: string | null;
  readonly spend?: number;
  readonly cpa?: number;
  readonly roas?: number;
  readonly summary: string | null;
  readonly topFinding: { readonly title: string; readonly severity: string } | null;
  readonly flags: readonly string[];
  /** SÓ presente quando a campanha é ABO com 2+ conjuntos com diagnóstico próprio (S8b) —
   *  cada conjunto tem seu tier; ausência = campanha CBO ou ABO com 1 conjunto só. */
  readonly adsets?: readonly AdsetBreakdownItem[];
  readonly adsetsNote?: string;
  readonly asOf: string;
}

/** Várias campanhas casaram o nome → o agente desambigua com opções NUMERADAS + id
 *  (o id explícito ao lado do número fecha a porta de misatribuição — o agente age pelo id). */
interface AmbiguousCampaign {
  readonly hasData: false;
  readonly ambiguous: true;
  readonly options: readonly { readonly n: number; readonly id: string; readonly name: string }[];
  readonly note: string;
}

interface RecommendationItem {
  readonly title: string;
  readonly rationale: string | null;
  readonly riskLevel: string;
  /** ação estruturada (só platform_action) — alvo p/ resolver a campanha no enriquecimento de status. */
  readonly proposedAction?: { readonly type: string; readonly target: { readonly level: string; readonly id: string } } | null;
  /** status AO VIVO (ativa/pausada) da campanha referenciada — anexado deterministicamente (não
   *  depende do LLM chamar tool). Ausente = não resolveu a campanha ou a Meta não respondeu. */
  readonly liveStatus?: { readonly campaignId: string; readonly name: string | null; readonly status: string } | null;
}

/** Aprovação de AÇÃO de otimização (a maioria das pendentes). */
interface PendingActionItem {
  readonly kind: "action";
  /** id da aprovação — o agente referencia por ele ao aprovar/rejeitar (5b-2.3). */
  readonly id: string;
  readonly entityLevel: string;
  readonly entityId: string;
  readonly entityName: string | null;
  readonly actionType: string;
  readonly reason: string;
  readonly expiresAt: string;
}

/** Aprovação de ATIVAÇÃO (P0.1 — 2º passo HITL, async): o rascunho já foi CRIADO pausado; isto
 *  pergunta "posso ativar?". Chega aqui (não no fluxo de confirmação em-turno da criação) porque
 *  a criação é assíncrona — o momento de confirmar ativação é depois, numa mensagem à parte. */
interface PendingActivationItem {
  readonly kind: "activation";
  readonly id: string;
  /** o que foi criado (PT, ex: "uma campanha de vendas, R$ 50,00/dia") — a ação é ATIVAR isso. */
  readonly reason: string;
  readonly expiresAt: string;
}

interface PendingDraftItem {
  readonly kind: "draft";
  readonly id: string;
  /** o que vai ser criado (PT) — a ação é APROVAR pra criar (ou recusar). */
  readonly reason: string;
  readonly expiresAt: string;
}

type PendingItem = PendingActionItem | PendingDraftItem | PendingActivationItem;

/** Snapshot de métricas do run (jsonb livre) — lido defensivamente. */
interface RunMetricsSnapshot {
  readonly kpis?: { readonly spend?: number };
  readonly scorecard?: { readonly grade?: string; readonly headline?: string };
  readonly waste?: {
    readonly wastedSpend?: number;
    readonly wastedPct?: number;
    readonly pareto?: {
      readonly misallocated?: readonly { readonly name?: string; readonly spendPct?: number; readonly resultPct?: number }[];
    };
  };
}

/** Curadoria do desperdício persistido → resumo escaneável p/ o chat. Material-only. */
function curateWasteForChat(waste: RunMetricsSnapshot["waste"]): AccountWaste | undefined {
  if (!waste) return undefined;
  const wastedSpend = typeof waste.wastedSpend === "number" ? waste.wastedSpend : 0;
  const misallocated = (waste.pareto?.misallocated ?? [])
    .slice(0, 2)
    .filter((m) => typeof m.spendPct === "number")
    .map((m) => ({
      name: m.name ?? null,
      spendPct: m.spendPct as number,
      ...(typeof m.resultPct === "number" ? { resultPct: m.resultPct } : {}),
    }));
  if (wastedSpend <= 0 && misallocated.length === 0) return undefined;
  return {
    wastedSpend,
    wastedPct: typeof waste.wastedPct === "number" ? waste.wastedPct : 0,
    ...(misallocated.length > 0 ? { misallocated } : {}),
  };
}

// ─── Funções de dados (puras/async, org-scoped) — testadas direto ────────────

/**
 * Último run finalizado do agente (org-scoped) + contagem de recomendações e de
 * aprovações pendentes da org. Sem run → `hasData:false`.
 */
export async function getAccountStatusData(
  db: Database,
  agentId: string,
  orgId: string,
  approvalPort: ApprovalPort,
): Promise<AccountStatus | NoData> {
  const run = await latestFinishedRun(db, agentId, orgId);
  if (!run) return { hasData: false, note: "sem análise concluída ainda" };

  const recIds = await db
    .select({ id: recommendations.id })
    .from(recommendations)
    .where(and(eq(recommendations.runId, run.id), eq(recommendations.orgId, orgId)));
  const pending = await approvalPort.listPendingByOrg(orgId as OrgId);

  const snap = (run.metricsSnapshot ?? null) as RunMetricsSnapshot | null;
  const spend = snap?.kpis?.spend;
  const waste = curateWasteForChat(snap?.waste);
  const partialNote = run.partial ? describePartialRun((run.partialReasons ?? []) as PartialReason[]) : null;
  return {
    grade: snap?.scorecard?.grade ?? null,
    headline: snap?.scorecard?.headline ?? null,
    summary: run.summary ?? null,
    ...(typeof spend === "number" ? { spend } : {}),
    ...(waste ? { waste } : {}),
    recommendationCount: recIds.length,
    pendingCount: pending.length,
    asOf: (run.finishedAt ?? run.createdAt).toISOString(),
    ...(partialNote ? { partialNote } : {}),
  };
}

/** Linha do panorama — versão enxuta de `AccountStatus` (sem recomendação/pendência,
 *  que é detalhe por-conta; aqui o objetivo é "quais contas, como cada uma está indo"). */
interface PortfolioAccountEntry {
  readonly accountName: string | null;
  /** moeda da conta (ISO) — o gasto de cada conta é na SUA moeda; nunca somar/comparar entre moedas. */
  readonly currency: string | null;
  readonly hasData: boolean;
  readonly grade: string | null;
  readonly headline: string | null;
  readonly spend?: number;
  readonly asOf: string; // ASOF_NONE quando hasData=false
}

interface PortfolioOverview {
  readonly accounts: readonly PortfolioAccountEntry[]; // até PORTFOLIO_OVERVIEW_MAX_ACCOUNTS, com detalhe, ordenado
  readonly otherAccountNames: readonly (string | null)[]; // resto, só nome — NUNCA omitido
  readonly totalCount: number; // total de contas ativas da org
}

/** Pior nota primeiro (D>C>B>A); sem nota (ainda sem análise) por último. */
const GRADE_SEVERITY: Readonly<Record<string, number>> = { D: 0, C: 1, B: 2, A: 3 };
function byGradeThenName(a: PortfolioAccountEntry, b: PortfolioAccountEntry): number {
  const ra = a.grade ? (GRADE_SEVERITY[a.grade] ?? 4) : 4;
  const rb = b.grade ? (GRADE_SEVERITY[b.grade] ?? 4) : 4;
  if (ra !== rb) return ra - rb;
  return (a.accountName ?? "").localeCompare(b.accountName ?? "", "pt-BR");
}

/**
 * Contas ativas da org + nota/resumo/gasto da ÚLTIMA análise concluída de cada uma —
 * panorama do portfólio. NÃO é o `AccountStatus` completo (sem recomendação/pendência,
 * reservado pra quando focar numa conta). 2 queries só (contas + `DISTINCT ON` de runs —
 * mesmo idiom de `apps/api/.../dashboard/service.ts` — sem N+1). Ordenado da pior nota
 * pra melhor, sem-dado por último (nunca omite, §UX). Detalhe cortado em
 * `PORTFOLIO_OVERVIEW_MAX_ACCOUNTS`; o resto vira só nome em `otherAccountNames` (nunca
 * some uma conta da resposta). Org sem conta ativa → `hasData:false`.
 */
export async function listAccountsData(db: Database, orgId: string): Promise<PortfolioOverview | NoData> {
  const rows = await db
    .select({ agentId: agents.id, accountName: adAccounts.name, currency: adAccounts.currency })
    .from(agents)
    .innerJoin(adAccounts, eq(agents.adAccountId, adAccounts.id))
    .where(and(eq(agents.orgId, orgId), eq(agents.status, "active"), eq(adAccounts.status, "active")));

  if (rows.length === 0) return { hasData: false, note: "nenhuma conta ativa nesta organização" };

  const latestRuns = await db
    .selectDistinctOn([agentRuns.agentId], {
      agentId: agentRuns.agentId,
      metricsSnapshot: agentRuns.metricsSnapshot,
      finishedAt: agentRuns.finishedAt,
      createdAt: agentRuns.createdAt,
    })
    .from(agentRuns)
    .where(and(eq(agentRuns.orgId, orgId), inArray(agentRuns.status, [...FINISHED_RUN_STATUSES])))
    .orderBy(agentRuns.agentId, desc(agentRuns.createdAt));
  const runByAgent = new Map(latestRuns.map((r) => [r.agentId, r]));

  const entries: PortfolioAccountEntry[] = rows.map((r) => {
    const run = runByAgent.get(r.agentId);
    if (!run)
      return { accountName: r.accountName, currency: r.currency ?? null, hasData: false, grade: null, headline: null, asOf: ASOF_NONE };
    const snap = (run.metricsSnapshot ?? null) as RunMetricsSnapshot | null;
    const spend = snap?.kpis?.spend;
    return {
      accountName: r.accountName,
      currency: r.currency ?? null,
      hasData: true,
      grade: snap?.scorecard?.grade ?? null,
      headline: snap?.scorecard?.headline ?? null,
      ...(typeof spend === "number" ? { spend } : {}),
      asOf: (run.finishedAt ?? run.createdAt).toISOString(),
    };
  });

  const sorted = [...entries].sort(byGradeThenName);
  const accounts = sorted.slice(0, PORTFOLIO_OVERVIEW_MAX_ACCOUNTS);
  const otherAccountNames = sorted.slice(PORTFOLIO_OVERVIEW_MAX_ACCOUNTS).map((e) => e.accountName);
  return { accounts, otherAccountNames, totalCount: rows.length };
}

/**
 * Gasto AGREGADO da conta nos últimos N dias. Prefere o nível `account`; sem linha
 * de conta, soma o nível `campaign` (equivalente ao total). Gasto é gasto — não há
 * basis nem CPA/ROAS derivado aqui. `asOf` = data do snapshot mais recente somado.
 */
export async function getMetricsData(
  db: Database,
  adAccountId: string,
  orgId: string,
  agentId: string,
  periodDays: number,
  tz: string,
  now: () => Date = () => new Date(),
): Promise<AccountMetrics | NoAccountMetrics> {
  const since = daysAgoInTz(now(), tz, periodDays);
  const accountRows = await spendRows(db, adAccountId, orgId, ACCOUNT_LEVEL, since);
  const rows = accountRows.length > 0 ? accountRows : await spendRows(db, adAccountId, orgId, CAMPAIGN_LEVEL, since);

  if (rows.length === 0) return { periodDays, spend: 0, asOf: ASOF_NONE, hasData: false };

  const asOf = rows.reduce((latest, r) => (r.date > latest ? r.date : latest), rows[0]!.date);
  const businessGoal = await loadBusinessGoal(db, orgId, agentId);
  const kpis = aggregateKpis(rows as Array<{ date: string; metricsJson: StoredInsightMetrics }>, businessGoal);
  const note = attributionCaveat(asOf, todayInTz(now(), tz));
  return { periodDays, asOf, hasData: true, ...kpis, ...(note ? { attributionNote: note } : {}) };
}

/**
 * Última análise de uma campanha por nome (case-insensitive, contains) entre as
 * análises por entidade do agente. 0 → `hasData:false`; 1 → cartão curado;
 * várias → lista os nomes p/ o agente desambiguar.
 */
export async function getCampaignAnalysisData(
  db: Database,
  agentId: string,
  name: string,
): Promise<CampaignAnalysis | NoData | AmbiguousCampaign> {
  // 1 query, TODOS os níveis (não só campanha): a quebra por-adset (S8b/S8) precisa dos
  // conjuntos da MESMA campanha, já disponíveis na mesma tabela — evita uma 2ª ida ao DB.
  const allRows = await db
    .select({
      entityId: entityAnalyses.entityId,
      entityLevel: entityAnalyses.entityLevel,
      entityName: entityAnalyses.entityName,
      unitJson: entityAnalyses.unitJson,
      metricsJson: entityAnalyses.metricsJson,
      flags: entityAnalyses.flags,
      curatedJson: entityAnalyses.curatedJson,
      analyzedAt: entityAnalyses.analyzedAt,
    })
    .from(entityAnalyses)
    .where(eq(entityAnalyses.agentId, agentId))
    .orderBy(desc(entityAnalyses.analyzedAt));
  const rows = allRows.filter((r) => r.entityLevel === CAMPAIGN_LEVEL);

  // Match determinístico (Dice + contenção + margem) — mesmo matcher do foco de conta
  // (`resolveNamedMatch`), tolera typo/acento/ordem e só autoescolhe com folga clara.
  const match = resolveNamedMatch(rows, name, { name: (r) => r.entityName, keys: (r) => [r.entityId] });
  if (match.kind === "none") {
    return { hasData: false, note: `nenhuma campanha analisada com "${name}" no nome` };
  }
  if (match.kind === "ambiguous") {
    return {
      hasData: false,
      ambiguous: true,
      options: match.rows.map((r, i) => ({ n: i + 1, id: r.entityId, name: r.entityName ?? "(sem nome)" })),
      note: 'mais de uma campanha casa esse nome — mostre as opções numeradas e peça o número; aja SEMPRE pelo id da opção escolhida (nunca por outra campanha)',
    };
  }

  const row = match.row;
  const unit = row.unitJson as Partial<UnitAnalysis>;
  const m = row.metricsJson as Partial<InsightMetrics>;
  const top = unit.findings?.[0];
  const curated = row.curatedJson ?? null;
  const adsets =
    curated?.isCBO === false
      ? allRows
          .filter((r) => r.entityLevel === ADSET_LEVEL && r.curatedJson?.campaignId === row.entityId)
          .map((r) => ({ id: r.entityId, name: r.entityName ?? null, tier: r.curatedJson?.tier ?? null }))
      : [];
  return {
    id: row.entityId,
    name: row.entityName ?? null,
    ...(typeof m.spend === "number" ? { spend: m.spend } : {}),
    ...(typeof m.cpa === "number" ? { cpa: m.cpa } : {}),
    ...(typeof m.roas === "number" ? { roas: m.roas } : {}),
    summary: unit.summary ?? null,
    topFinding: top ? { title: top.title, severity: top.severity } : null,
    flags: row.flags ?? [],
    ...curatedViewOf(curated),
    ...(adsets.length >= MIN_ADSETS_FOR_BREAKDOWN ? { adsets, adsetsNote: ADSET_BREAKDOWN_NOTE } : {}),
    asOf: row.analyzedAt.toISOString(),
  };
}

/**
 * TODAS as campanhas analisadas (última análise por campanha) com métricas curadas — p/ o
 * agente COMPARAR/ALOCAR verba entre elas (ex.: "quais gastam mais e convertem pior"). Ordena
 * por gasto desc. `entity_analyses` é upsertado (1 linha/campanha); dedup defensivo por id.
 */
export async function listCampaignsData(
  db: Database,
  agentId: string,
): Promise<
  | {
      hasData: true;
      asOf: string;
      campaigns: Array<
        {
          id: string;
          name: string | null;
          spend: number | null;
          conversions: number | null;
          cpa: number | null;
          roas: number | null;
          revenue: number | null;
        } & CuratedView
      >;
    }
  | NoData
> {
  const rows = await db
    .select({
      entityId: entityAnalyses.entityId,
      entityName: entityAnalyses.entityName,
      metricsJson: entityAnalyses.metricsJson,
      tier: entityAnalyses.tier,
      curatedJson: entityAnalyses.curatedJson,
      analyzedAt: entityAnalyses.analyzedAt,
    })
    .from(entityAnalyses)
    .where(and(eq(entityAnalyses.agentId, agentId), eq(entityAnalyses.entityLevel, CAMPAIGN_LEVEL)))
    .orderBy(desc(entityAnalyses.analyzedAt));
  if (rows.length === 0) return { hasData: false, note: "nenhuma campanha analisada ainda" };

  const seen = new Set<string>();
  const campaigns = [];
  for (const r of rows) {
    if (seen.has(r.entityId)) continue; // 1ª (mais recente) por campanha
    seen.add(r.entityId);
    const m = r.metricsJson as Partial<InsightMetrics>;
    campaigns.push({
      id: r.entityId,
      name: r.entityName ?? null,
      ...curatedViewOf(r.curatedJson ?? null),
      spend: typeof m.spend === "number" ? m.spend : null,
      conversions: typeof m.conversions === "number" ? m.conversions : null,
      cpa: typeof m.cpa === "number" ? m.cpa : null,
      roas: typeof m.roas === "number" ? m.roas : null,
      revenue: typeof m.revenue === "number" ? m.revenue : null,
      tier: r.tier ?? null,
    });
  }
  campaigns.sort((a, b) => (b.spend ?? 0) - (a.spend ?? 0));
  return { hasData: true, asOf: rows[0]!.analyzedAt.toISOString(), campaigns };
}

/** Recomendações do último run finalizado do agente + `asOf` (frescor — QUANDO a análise rodou).
 *  Vazio → `hasData:false`. O `asOf` é o carimbo: recs dependentes de status (reativar/pausar) podem
 *  ter horas → o agente confirma ao vivo (get_campaign_status) antes de agir/afirmar. */
export async function listRecommendationsData(
  db: Database,
  agentId: string,
  orgId: string,
): Promise<{ hasData: true; asOf: string; recommendations: RecommendationItem[] } | NoData> {
  const run = await latestFinishedRun(db, agentId, orgId);
  if (!run) return { hasData: false, note: "sem análise concluída ainda" };

  const recs = await db
    .select({
      title: recommendations.title,
      rationale: recommendations.rationale,
      riskLevel: recommendations.riskLevel,
      proposedAction: recommendations.proposedAction,
    })
    .from(recommendations)
    .where(and(eq(recommendations.runId, run.id), eq(recommendations.orgId, orgId)));

  if (recs.length === 0) return { hasData: false, note: "a última análise não gerou recomendações" };
  const asOf = (run.finishedAt ?? run.createdAt).toISOString();
  return {
    hasData: true,
    asOf,
    recommendations: recs.map((r) => {
      const a = r.proposedAction as { type: string; target: { level: string; id: string } } | null;
      return {
        title: r.title,
        rationale: r.rationale ?? null,
        riskLevel: r.riskLevel,
        proposedAction: a ? { type: a.type, target: { level: a.target.level, id: a.target.id } } : null,
      };
    }),
  };
}

/** Palavras que marcam uma recomendação DEPENDENTE DE STATUS (reativar/pausar/substituir/ligar/
 *  desligar/escalar) — só nessas vale gastar uma leitura ao vivo do status (bounded). */
const STATUS_REC_RE = /reativ|reative|pausa|despausa|ligar|desligar|substitu|ativa|inativ|escala|retom/i;
/** Teto de leituras de status ao vivo por chamada (bounded — não reintroduz rate-limit). */
const LIVE_STATUS_MAX = 6;

/**
 * Enriquecimento DETERMINÍSTICO (não depende do LLM chamar tool): para cada recomendação
 * dependente de status, resolve a campanha (alvo estruturado OU nome no título/rationale via
 * catálogo ao vivo) e anexa o STATUS FRESCO (readEntityState — bypassa o cache). Assim o modelo
 * sempre VÊ "está ativa/pausada AGORA" ao lado da rec — matando a inferência-por-gasto e o repasse
 * de rec stale (ex: "reativar X" quando X já está ativa). Best-effort/bounded: sem token/Meta lenta
 * → apenas não anexa (a rec segue com o carimbo asOf). PURO de decisão; IO via ports.
 */
export async function enrichRecommendationsLiveStatus(
  deps: WorkerDeps,
  ctx: ReadToolContext,
  data: { hasData: true; asOf: string; recommendations: RecommendationItem[] },
): Promise<{ hasData: true; asOf: string; recommendations: RecommendationItem[] }> {
  const repo = createAnalysisRepo(deps.db);
  const account = await repo.loadAccount(ctx.orgId, ctx.adAccountId);
  if (!account) return data;
  const ref = { adAccountId: account.metaAdAccountId, accessToken: deps.ports.vault.decrypt(account.tokenCripto) };

  // catálogo (todas as campanhas, inclusive PAUSADAS) p/ resolver nome→id da rec. Cacheável (só
  // resolução; o STATUS vem fresco do readEntityState abaixo). Meta lenta → segue sem enriquecer.
  let catalog: Array<{ id: string; name: string }> = [];
  try {
    const ents = await withTimeout(deps.ports.ads.listEntities(ref, "campaign"), deps.conversation.liveFetchTimeoutMs);
    catalog = ents.map((e) => ({ id: e.id, name: e.name }));
  } catch {
    return data; // sem catálogo não dá pra resolver com segurança
  }
  const nameById = new Map(catalog.map((e) => [e.id, e.name]));

  // resolve a campanha de cada rec dependente de status → ids únicos (bounded).
  const idByRec = new Map<number, string>();
  const ids = new Set<string>();
  data.recommendations.forEach((r, i) => {
    const text = `${r.title} ${r.rationale ?? ""}`;
    if (!STATUS_REC_RE.test(text)) return;
    // 1) alvo estruturado (platform_action). 2) id numérico CITADO no texto que existe no catálogo
    // (o analista cita o id — robusto p/ "Reativar X"). 3) fuzzy pelo nome, sem o verbo inicial.
    let id: string | null = r.proposedAction?.target.level === "campaign" ? r.proposedAction.target.id : null;
    if (!id) {
      for (const m of text.matchAll(/\b(\d{8,})\b/g)) {
        if (nameById.has(m[1]!)) {
          id = m[1]!;
          break;
        }
      }
    }
    if (!id) {
      const q = r.title.replace(/^\s*(reativ\w*|pausa\w*|despausa\w*|substitu\w*|escala\w*|retom\w*|ligar|desligar|ativa\w*)\s*/i, "");
      const m = resolveNamedMatch(catalog, q, { name: (e) => e.name, keys: (e) => [e.id] });
      if (m.kind === "one") id = m.row.id;
    }
    if (id && ids.size < LIVE_STATUS_MAX) {
      idByRec.set(i, id);
      ids.add(id);
    }
  });
  if (ids.size === 0) return data;

  // STATUS FRESCO por id (bounded, best-effort). Falha numa → só não anexa aquela.
  const statusById = new Map<string, string>();
  for (const id of ids) {
    try {
      const raw = await withTimeout(deps.ports.ads.readEntityState(ref, id), deps.conversation.liveFetchTimeoutMs);
      statusById.set(id, mapStatus(raw["effective_status"] as string | undefined, raw["status"] as string | undefined));
    } catch {
      /* segue sem essa */
    }
  }
  const recommendations = data.recommendations.map((r, i) => {
    const id = idByRec.get(i);
    const status = id ? statusById.get(id) : undefined;
    return id && status ? { ...r, liveStatus: { campaignId: id, name: nameById.get(id) ?? null, status } } : r;
  });
  return { ...data, recommendations };
}

/** Aprovações pendentes da org (cross-conta por design). Vazio → `hasData:false`. `action` +
 *  `draft` (criação) + `activation` (P0.1) entram aqui — todas com id p/ aprovar/recusar por
 *  referência. `draft` passou a entrar (antes ficava só no eco de 30min): a approval vive 24h, o
 *  eco efêmero expira — sem isto, um rascunho ficava invisível ao chat depois de 30min (não dava
 *  pra recusar). O eco/`confirm_write` segue pro "sim/não" imediato do mesmo turno. */
export async function listPendingData(
  db: Pick<Database, "select">,
  approvalPort: ApprovalPort,
  orgId: string,
): Promise<PendingItem[] | NoData> {
  const all = await approvalPort.listPendingByOrg(orgId as OrgId);
  const actions = all.filter((a): a is Approval => a.kind === "action");
  const drafts = all.filter((a): a is DraftApproval => a.kind === "draft");
  const activations = all.filter((a): a is ActivationApproval => a.kind === "activation");
  if (actions.length === 0 && drafts.length === 0 && activations.length === 0) {
    return { hasData: false, note: "nenhuma ação nem rascunho aguardando aprovação" };
  }

  const actionItems: PendingActionItem[] = actions.map((a) => ({
    kind: "action",
    id: a.id,
    entityLevel: a.entityLevel,
    entityId: a.entityId,
    entityName: a.action.target?.name ?? null,
    actionType: a.actionType,
    // ressalvas de escala (Fatia A): viajam no reason pro chat mencionar o "porém" ao listar/aprovar.
    reason: a.action.ressalvas?.length ? `${a.action.reason} — ${renderRessalvas(a.action.ressalvas)}` : a.action.reason,
    expiresAt: a.expiresAt.toISOString(),
  }));

  // draft (criar) + activation (ativar o já-criado) referenciam campaign_drafts → 1 query só.
  const draftRefs = [...drafts, ...activations];
  const byDraftId = new Map<string, { kind: DraftKind; spec: unknown }>();
  if (draftRefs.length > 0) {
    const rows = await db
      .select({ id: campaignDrafts.id, kind: campaignDrafts.kind, spec: campaignDrafts.spec })
      .from(campaignDrafts)
      .where(and(eq(campaignDrafts.orgId, orgId as OrgId), inArray(campaignDrafts.id, draftRefs.map((a) => a.draftId))));
    for (const d of rows) byDraftId.set(d.id, { kind: d.kind, spec: d.spec });
  }
  const whatOf = (draftId: string, fallback: string): string => {
    const d = byDraftId.get(draftId);
    return d ? describeCreatedDraft(d.kind, d.spec as CampaignDraftSpec) : fallback;
  };

  const draftItems: PendingDraftItem[] = drafts.map((a) => ({
    kind: "draft",
    id: a.id,
    reason: `criar ${whatOf(a.draftId, "uma campanha")}`,
    expiresAt: a.expiresAt.toISOString(),
  }));

  const activationItems: PendingActivationItem[] = activations.map((a) => ({
    kind: "activation",
    id: a.id,
    reason: `ativar ${whatOf(a.draftId, "o que foi criado")}`,
    expiresAt: a.expiresAt.toISOString(),
  }));

  return [...actionItems, ...draftItems, ...activationItems];
}

/** Ação REAL recente que pode ser desfeita (id p/ o agente reverter no chat, 5c-4). */
interface RecentAction {
  readonly id: string;
  readonly type: string;
  readonly entityName: string | null;
  readonly appliedAt: string;
}

/**
 * Ações REAIS recentes (últimos N dias) do agente que ainda NÃO foram revertidas —
 * base do "desfaz isso" / "desfaz a pausa da X". Cobre ações de análise (via run) e de
 * chat (via agentId) com coalesce. Exclui simuladas, undo/undo_blocked e já-revertidas.
 */
export async function findRecentActionsData(
  db: Database,
  agentId: string,
  opts: { nameFilter?: string; limit?: number; sinceDays?: number } = {},
): Promise<RecentAction[] | NoData> {
  const since = daysAgo(new Date(), opts.sinceDays ?? RECENT_ACTIONS_DAYS);
  const ownerOf = sql`coalesce(${agentToolCalls.agentId}, ${agentRuns.agentId})`;
  const rows = await db
    .select({ id: agentToolCalls.id, toolKey: agentToolCalls.toolKey, args: agentToolCalls.args, createdAt: agentToolCalls.createdAt })
    .from(agentToolCalls)
    .leftJoin(agentRuns, eq(agentToolCalls.runId, agentRuns.id))
    .where(and(eq(ownerOf, agentId), gte(agentToolCalls.createdAt, since)))
    .orderBy(desc(agentToolCalls.createdAt));

  // ids já revertidos (undo aponta pro original via args.revertOf).
  const reverted = new Set<string>();
  for (const r of rows) {
    if (r.toolKey !== UNDO_TOOL_KEY) continue;
    const of = (r.args as { revertOf?: string }).revertOf;
    if (of) reverted.add(of);
  }

  const needle = opts.nameFilter?.trim().toLowerCase();
  const items: RecentAction[] = [];
  for (const r of rows) {
    if (r.toolKey === UNDO_TOOL_KEY || r.toolKey === UNDO_BLOCKED_TOOL_KEY) continue;
    const a = r.args as { target?: { name?: string }; dryRun?: boolean };
    if (a.dryRun || reverted.has(r.id)) continue; // simulada ou já desfeita
    const name = a.target?.name ?? null;
    if (needle && !(name ?? "").toLowerCase().includes(needle)) continue;
    items.push({ id: r.id, type: r.toolKey, entityName: name, appliedAt: r.createdAt.toISOString() });
    if (items.length >= (opts.limit ?? RECENT_ACTIONS_LIMIT)) break;
  }

  if (items.length === 0) return { hasData: false, note: "nenhuma ação recente pra desfazer" };
  return items;
}

/**
 * Gasto da conta em DUAS janelas contíguas de N dias (atual vs anterior) + variação %.
 * Base do "como foi essa semana vs a passada". Só gasto (sem CPA/ROAS derivado).
 */
export async function comparePeriodsData(
  db: Database,
  adAccountId: string,
  orgId: string,
  periodDays: number,
  tz: string,
  now: () => Date = () => new Date(),
): Promise<{ periodDays: number; current: number; previous: number; deltaPct: number | null; hasData: boolean }> {
  const curSince = daysAgoInTz(now(), tz, periodDays);
  const prevSince = daysAgoInTz(now(), tz, periodDays * 2);
  const rows = await db
    .select({ date: insightsSnapshots.date, metricsJson: insightsSnapshots.metricsJson, level: insightsSnapshots.entityLevel })
    .from(insightsSnapshots)
    .where(
      and(
        eq(insightsSnapshots.orgId, orgId),
        eq(insightsSnapshots.adAccountId, adAccountId),
        gte(insightsSnapshots.date, prevSince),
      ),
    );
  const level = rows.some((r) => r.level === ACCOUNT_LEVEL) ? ACCOUNT_LEVEL : CAMPAIGN_LEVEL;
  let current = 0;
  let previous = 0;
  for (const r of rows) {
    if (r.level !== level) continue;
    if (r.date >= curSince) current += spendOf(r.metricsJson);
    else previous += spendOf(r.metricsJson);
  }
  const deltaPct = previous > 0 ? Math.round(((current - previous) / previous) * 100) : null;
  return { periodDays, current, previous, deltaPct, hasData: rows.length > 0 };
}

/** Tendência diária de gasto de UMA campanha (por nome) — "como o gasto da X evoluiu". */
export async function getEntityDetailData(
  db: Database,
  agentId: string,
  adAccountId: string,
  orgId: string,
  name: string,
  tz: string,
  periodDays = ENTITY_TREND_DAYS,
  now: () => Date = () => new Date(),
): Promise<
  | ({ name: string | null; id: string; trend: { date: string; spend: number }[]; totalSpend: number; flags: readonly string[]; adsets?: readonly AdsetBreakdownItem[]; adsetsNote?: string } & CuratedView)
  | NoData
  | AmbiguousCampaign
> {
  const analysis = await getCampaignAnalysisData(db, agentId, name);
  if ("hasData" in analysis) return analysis; // NoData | AmbiguousCampaign
  const since = daysAgoInTz(now(), tz, periodDays);
  const rows = await db
    .select({ date: insightsSnapshots.date, metricsJson: insightsSnapshots.metricsJson })
    .from(insightsSnapshots)
    .where(
      and(
        eq(insightsSnapshots.orgId, orgId),
        eq(insightsSnapshots.adAccountId, adAccountId),
        eq(insightsSnapshots.entityLevel, CAMPAIGN_LEVEL),
        eq(insightsSnapshots.entityId, analysis.id),
        gte(insightsSnapshots.date, since),
      ),
    )
    .orderBy(insightsSnapshots.date);
  const trend = rows.map((r) => ({ date: r.date, spend: spendOf(r.metricsJson) }));
  const totalSpend = trend.reduce((s, t) => s + t.spend, 0);
  return {
    name: analysis.name,
    id: analysis.id,
    trend,
    totalSpend,
    flags: analysis.flags,
    tier: analysis.tier,
    budget: analysis.budget,
    atBudgetCeiling: analysis.atBudgetCeiling,
    isCBO: analysis.isCBO,
    healthSignals: analysis.healthSignals,
    audience: analysis.audience,
    funnel: analysis.funnel,
    conversionBasis: analysis.conversionBasis,
    benchmarkRef: analysis.benchmarkRef,
    deactivatedSince: analysis.deactivatedSince,
    ...(analysis.adsets ? { adsets: analysis.adsets, adsetsNote: analysis.adsetsNote } : {}),
  };
}

/** Config atual do agente (só leitura) — "como você tá configurado?". Mudar = pelo site. */
export async function getAgentConfigData(
  db: Database,
  orgId: string,
  agentId: string,
): Promise<{ goals: unknown; autonomy: unknown; guardrails: unknown; notifications: unknown; archetype: string } | NoData> {
  const ctx = await createAnalysisRepo(db).loadAgentContext(orgId, agentId);
  if (!ctx) return { hasData: false, note: "não achei a configuração deste agente" };
  const g = ctx.guardrailConfig;
  return {
    archetype: ctx.archetype,
    goals: ctx.goals,
    autonomy: ctx.autonomyPolicy,
    guardrails: {
      allowedActions: g.allowedActions,
      maxBudgetChangePct: g.maxBudgetChangePct,
      maxEntitiesPerDay: g.maxEntitiesPerDay,
      dryRun: g.dryRun,
      killSwitch: g.killSwitch,
    },
    // avisos proativos REAIS (pulso/alerta/reativação/saúde da conta com limiares de teto e
    // saldo) — pro agente citar o valor CERTO ("seu alerta de saldo é R$50"), nunca inventar.
    notifications: ctx.notifyPolicy,
  };
}

/** Explica uma recomendação da última análise (por trecho do título) — motivo + risco +
 *  impacto/monitoramento (S0b/G4, quando o analista conseguiu ancorar em dado real). */
export async function explainRecommendationData(
  db: Database,
  agentId: string,
  orgId: string,
  title: string,
): Promise<
  | { title: string; rationale: string | null; riskLevel: string; expectedImpact: string | null; whatToMonitor: string | null }
  | NoData
> {
  const run = await latestFinishedRun(db, agentId, orgId);
  if (!run) return { hasData: false, note: "sem análise concluída ainda" };
  const recs = await db
    .select({
      title: recommendations.title,
      rationale: recommendations.rationale,
      riskLevel: recommendations.riskLevel,
      expectedImpact: recommendations.expectedImpact,
      whatToMonitor: recommendations.whatToMonitor,
    })
    .from(recommendations)
    .where(and(eq(recommendations.runId, run.id), eq(recommendations.orgId, orgId)));
  const needle = title.trim().toLowerCase();
  const match = recs.find((r) => r.title.toLowerCase().includes(needle)) ?? (recs.length === 1 ? recs[0] : undefined);
  if (!match) return { hasData: false, note: `não achei uma recomendação com "${title}"` };
  return {
    title: match.title,
    rationale: match.rationale ?? null,
    riskLevel: match.riskLevel,
    expectedImpact: match.expectedImpact ?? null,
    whatToMonitor: match.whatToMonitor ?? null,
  };
}

// ─── Helpers internos ────────────────────────────────────────────────────────

/** Último run finalizado (succeeded/failed) do agente, org-scoped. */
async function latestFinishedRun(db: Database, agentId: string, orgId: string) {
  const [run] = await db
    .select({
      id: agentRuns.id,
      summary: agentRuns.summary,
      metricsSnapshot: agentRuns.metricsSnapshot,
      createdAt: agentRuns.createdAt,
      finishedAt: agentRuns.finishedAt,
      partial: agentRuns.partial,
      partialReasons: agentRuns.partialReasons,
    })
    .from(agentRuns)
    .where(
      and(
        eq(agentRuns.agentId, agentId),
        eq(agentRuns.orgId, orgId),
        inArray(agentRuns.status, [...FINISHED_RUN_STATUSES]),
      ),
    )
    .orderBy(desc(agentRuns.createdAt))
    .limit(1);
  return run;
}

/**
 * Data/hora da ÚLTIMA análise concluída do agente = o `asOf` do dado curado que o chat tem em
 * mãos (o MESMO que `get_account_status`/`list_recommendations` reportam). Alimenta a linha de
 * frescor injetada no system prompt do chat (nodes.ts) pra o LLM saber DE QUANDO são os números
 * — inclusive os que ele acabou de empurrar no push de "análise concluída" — sem depender de uma
 * chamada de tool. `null` = nenhuma análise concluída ainda.
 */
export async function latestAnalysisAsOf(db: Database, agentId: string, orgId: string): Promise<Date | null> {
  const run = await latestFinishedRun(db, agentId, orgId);
  return run ? (run.finishedAt ?? run.createdAt) : null;
}

/** Linhas de gasto (data + metricsJson) de um nível na janela — org-scoped. */
async function spendRows(db: Database, adAccountId: string, orgId: string, level: EntityLevel, since: string) {
  return db
    .select({ date: insightsSnapshots.date, metricsJson: insightsSnapshots.metricsJson })
    .from(insightsSnapshots)
    .where(
      and(
        eq(insightsSnapshots.orgId, orgId),
        eq(insightsSnapshots.adAccountId, adAccountId),
        eq(insightsSnapshots.entityLevel, level),
        gte(insightsSnapshots.date, since),
      ),
    );
}

/** Gasto de um snapshot (StoredInsightMetrics: escalares aninhados em `metrics`). */
function spendOf(metricsJson: { readonly metrics?: { readonly spend?: number } }): number {
  const spend = metricsJson?.metrics?.spend;
  return typeof spend === "number" ? spend : 0;
}

/** Instante N dias atrás (p/ comparar com timestamptz — find_recent_actions). */
function daysAgo(from: Date, days: number): Date {
  const d = new Date(from);
  d.setUTCDate(d.getUTCDate() - (days - 1));
  return d;
}

// ─── Montagem das tools (LangChain) ──────────────────────────────────────────

/** Serializa a saída curada p/ a string que o modelo lê. */
function asString(value: unknown): string {
  return JSON.stringify(value);
}

/** Teto de criativos retornados ao chat (WhatsApp não é parede de texto). */
export const TOP_CREATIVES_LIMIT = 5;

/** Ad ids a refrescar ao vivo (fresh=true): só o TOP-N que será exibido, ranqueado do
 *  persistido (campeã→pior). Puro — o refresh ao vivo não puxa a conta inteira da Meta. */
export function pickAdIdsToRefresh<T extends RankableCreative & { adId: string }>(rows: readonly T[]): string[] {
  return rankAdCreatives(rows)
    .slice(0, TOP_CREATIVES_LIMIT)
    .map((r) => r.adId);
}

/** Descreve o PÚBLICO do rascunho pelo MODO (só 2 hoje), sem jargão Meta nem chamada à
 *  plataforma. O público não é editável por texto livre → o detalhe exato do reuse não
 *  ajudaria (e custaria uma chamada Meta que estoura o turno). §UX. */
export function describeDraftAudience(targeting: TargetingSpec | undefined): string {
  return targeting?.kind === "reuse_adset"
    ? "herda o público do conjunto do seu anúncio reusado (a mesma segmentação que já converte)"
    : "público amplo — a Meta escolhe quem tem mais chance de converter";
}

/** Rótulo do criativo do rascunho, do nosso DB (nunca inventa). Reuse → nomeia o anúncio real
 *  (título salvo em ad_creatives) ou fala genérico honesto; upload → biblioteca; duplicate não
 *  tem criativo próprio (clona o vencedor inteiro). */
export function describeDraftCreative(
  kind: DraftKind,
  creative: CreativeAssetRef | undefined,
  titleByAdId: ReadonlyMap<string, string>,
): string {
  if (!creative) {
    return kind === "duplicate"
      ? "usa o mesmo criativo do vencedor (a duplicata clona o anúncio inteiro)"
      : "sem criativo definido ainda";
  }
  const fmt = creative.format === "video" ? "vídeo" : "imagem";
  if (creative.origin === "reuse") {
    const title = titleByAdId.get(creative.assetId);
    return title
      ? `reusa seu anúncio "${title}" (${fmt})`
      : `reusa um anúncio que já veicula na sua conta (${fmt})`;
  }
  return `usa um criativo da sua biblioteca (${fmt})`;
}

/** Detalhe RICO do(s) rascunho(s) pendente(s) da conta — do BANCO (spec + approval de 24h), não
 *  do estado efêmero da conversa (30min). Responde "qual público/criativo" na hora, sem Meta. O
 *  `approvalId` deixa o usuário aprovar/recusar por referência (approve/reject). */
async function getPendingDraftData(
  db: Database,
  approvalPort: ApprovalPort,
  orgId: string,
  agentId: string,
  adAccountId: string,
): Promise<NoData | { hasData: true; drafts: readonly unknown[] }> {
  const pending = (await approvalPort.listPendingByAgent(agentId as AgentId)).filter(
    (a): a is DraftApproval => a.kind === "draft",
  );
  if (pending.length === 0) {
    return { hasData: false, note: "não há rascunho de campanha aguardando sua aprovação nessa conta agora." };
  }
  const drafts = await db
    .select({ id: campaignDrafts.id, kind: campaignDrafts.kind, spec: campaignDrafts.spec })
    .from(campaignDrafts)
    .where(
      and(
        inArray(
          campaignDrafts.id,
          pending.map((a) => a.draftId),
        ),
        eq(campaignDrafts.orgId, orgId),
        eq(campaignDrafts.adAccountId, adAccountId),
      ),
    );
  const byId = new Map(drafts.map((d) => [d.id, d]));

  // rótulo do criativo reusado = título REAL do anúncio (join ad_creatives por ad_id), 1 query.
  const reuseAdIds = drafts
    .map((d) => (d.spec as CampaignDraftSpec).creative)
    .filter((c): c is CreativeAssetRef => c?.origin === "reuse")
    .map((c) => c.assetId);
  const titleByAdId = new Map<string, string>();
  if (reuseAdIds.length > 0) {
    const rows = await db
      .select({ adId: adCreatives.adId, title: adCreatives.title, body: adCreatives.body })
      .from(adCreatives)
      .where(and(inArray(adCreatives.adId, reuseAdIds), eq(adCreatives.orgId, orgId)));
    for (const r of rows) {
      const label = r.title ?? (r.body ? r.body.split("\n")[0]!.slice(0, 50) : "");
      if (label) titleByAdId.set(r.adId, label);
    }
  }

  const items = pending.flatMap((a) => {
    const d = byId.get(a.draftId);
    if (!d) return [];
    const spec = d.spec as CampaignDraftSpec;
    return [
      {
        approvalId: a.id,
        resumo: describeCreatedDraft(d.kind, spec),
        criativo: describeDraftCreative(d.kind, spec.creative, titleByAdId),
        publico: describeDraftAudience(spec.targeting),
        copies: spec.copyVariants?.map((c) => c.headline) ?? [],
      },
    ];
  });
  return { hasData: true, drafts: items };
}

/** "Qual minha copy campeã": lê `ad_creatives` (copy + desempenho denormalizado),
 *  ranqueia (puro, core) e devolve o top-N curado. Org-scoped. */
async function getTopCreativesData(
  db: Database,
  adAccountUuid: string,
  orgId: string,
): Promise<NoData | { hasData: true; creatives: readonly unknown[] }> {
  const rows = await db
    .select({
      adId: adCreatives.adId,
      name: adCreatives.name,
      tier: adCreatives.tier,
      spend: adCreatives.spend,
      cpa: adCreatives.cpa,
      roas: adCreatives.roas,
      body: adCreatives.body,
      title: adCreatives.title,
      callToAction: adCreatives.callToAction,
    })
    .from(adCreatives)
    .where(and(eq(adCreatives.adAccountId, adAccountUuid), eq(adCreatives.orgId, orgId)));
  if (rows.length === 0) {
    return {
      hasData: false,
      note: "Ainda não tenho as copies desta conta — rode uma análise (ou me peça as métricas de hoje) que eu capturo.",
    };
  }
  const creatives = rankAdCreatives(rows)
    .slice(0, TOP_CREATIVES_LIMIT)
    .map((r) => ({
      adId: r.adId,
      // nome do ANÚNCIO no Ads Manager — diferente de `title` (headline da copy).
      // Ausente = a Meta não retornou nome nesse anúncio (não inventar).
      ...(r.name ? { name: r.name } : {}),
      ...(r.tier ? { tier: r.tier } : {}),
      ...(r.roas != null ? { roas: r.roas } : {}),
      ...(r.cpa != null ? { cpa: r.cpa } : {}),
      ...(r.spend != null ? { spend: r.spend } : {}),
      ...(r.title ? { title: r.title } : {}),
      ...(r.body ? { copy: r.body } : {}),
      ...(r.callToAction ? { cta: r.callToAction } : {}),
    }));
  return { hasData: true, creatives };
}

/** Saúde da conta Meta pro chat (S5) — persistido pelo sync. Expõe saldo/gasto/teto
 *  (dado da própria conta do dono, contato verificado) pra responder "qual meu saldo";
 *  só o RÓTULO do cartão/pagamento fica no site, atrás de login (nunca por aqui).
 *  `tokenExpired` é checado ANTES de qualquer round-trip (sem token, nada funciona —
 *  responde direto sem tentar a Meta). Valores em unidade MAIOR; `null` = sem o dado
 *  (teto null = sem teto definido na Meta). */
interface AccountHealthView {
  readonly hasData: true;
  readonly status: string;
  readonly statusLabel: string;
  readonly tokenExpired: boolean;
  readonly currency: string | null;
  readonly balanceMajor: number | null;
  readonly amountSpentMajor: number | null;
  readonly spendCapMajor: number | null;
  readonly checkedAt: string | null;
}

/**
 * Saúde da conta Meta (S5): lê as colunas persistidas de `ad_accounts` (Fatia 2).
 * Checa `tokenStatus` PRIMEIRO — inválido → responde direto ("reconecte") sem
 * round-trip (achado: hoje NENHUMA tool de chat olha tokenStatus). Org-scoped.
 */
export async function getAccountHealthData(
  db: Database,
  adAccountUuid: string,
  orgId: string,
  logger?: WorkerDeps["logger"],
): Promise<AccountHealthView | NoData> {
  let row:
    | {
        tokenStatus: string;
        metaAccountStatus: string | null;
        currency: string | null;
        metaBalance: string | null;
        metaAmountSpent: string | null;
        metaSpendCap: string | null;
        metaHealthCheckedAt: Date | null;
      }
    | undefined;
  try {
    [row] = await db
      .select({
        tokenStatus: adAccounts.tokenStatus,
        metaAccountStatus: adAccounts.metaAccountStatus,
        currency: adAccounts.currency,
        metaBalance: adAccounts.metaBalance,
        metaAmountSpent: adAccounts.metaAmountSpent,
        metaSpendCap: adAccounts.metaSpendCap,
        metaHealthCheckedAt: adAccounts.metaHealthCheckedAt,
      })
      .from(adAccounts)
      .where(and(eq(adAccounts.id, adAccountUuid), eq(adAccounts.orgId, orgId)))
      .limit(1);
  } catch (err) {
    // nunca vaza detalhe técnico (nome de coluna/stack) pro chat (§13) — nota amigável.
    logger?.warn({ err: String(err) }, "get_account_health:leitura degradou");
    return { hasData: false, note: "não consegui checar a saúde da conta agora. Tenta de novo em instantes." };
  }
  if (!row) return { hasData: false, note: "conta não encontrada." };

  const tokenExpired = row.tokenStatus === "invalid";
  const status = (row.metaAccountStatus as MetaAccountHealthStatus | null) ?? (tokenExpired ? "unknown" : "active");
  const statusLabel =
    status === "active"
      ? "conta ativa e funcionando normalmente"
      : ACCOUNT_HEALTH_STATUS_LABELS[status as Exclude<MetaAccountHealthStatus, "active">];
  return {
    hasData: true,
    status,
    statusLabel,
    tokenExpired,
    currency: row.currency ?? null,
    balanceMajor: toMajorNumber(row.metaBalance),
    amountSpentMajor: toMajorNumber(row.metaAmountSpent),
    spendCapMajor: toMajorNumber(row.metaSpendCap),
    checkedAt: row.metaHealthCheckedAt ? row.metaHealthCheckedAt.toISOString() : null,
  };
}

/** Coluna numeric (text) → number em unidade maior; vazio/NaN → null (nunca "0" enganoso). */
function toMajorNumber(v: string | null): number | null {
  if (v === null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Refresh ao vivo da saúde da conta (S5, `fresh=true`) — mesmo padrão de
 * `refreshCreativeCopiesLive`: carrega a conta, decripta o token, chama
 * `getAccountHealth` e faz upsert das MESMAS colunas de `ad_accounts` (reusa a
 * persistência da Fatia 2). Best-effort — o chamador degrada pro persistido.
 */
async function refreshAccountHealthLive(deps: WorkerDeps, ctx: ReadToolContext): Promise<void> {
  const repo = createAnalysisRepo(deps.db);
  const account = await repo.loadAccount(ctx.orgId, ctx.adAccountId);
  if (!account) return;
  const ref = { adAccountId: account.metaAdAccountId, accessToken: deps.ports.vault.decrypt(account.tokenCripto) };
  const health = await deps.ports.ads.getAccountHealth(ref);
  await deps.db
    .update(adAccounts)
    .set({
      metaAccountStatus: health.status,
      metaDisableReason: health.disableReason ?? null,
      metaBalance: health.balanceMajor !== undefined ? String(health.balanceMajor) : null,
      metaAmountSpent: health.amountSpentMajor !== undefined ? String(health.amountSpentMajor) : null,
      metaSpendCap: health.spendCapMajor !== undefined ? String(health.spendCapMajor) : null,
      metaPaymentMethodLabel: health.paymentMethodLabel ?? null,
      metaFundingType: health.fundingType ?? null,
      metaHealthCheckedAt: new Date(health.checkedAt),
    })
    .where(and(eq(adAccounts.id, ctx.adAccountId), eq(adAccounts.orgId, ctx.orgId)));
}

/**
 * Busca em TEMPO REAL na Meta (S1.5): puxa os criativos ao vivo (`getCreatives`)
 * e faz upsert SÓ da copy (preserva o desempenho do último run). Best-effort —
 * o chamador degrada pro persistido em erro. Sob o governor do adapter.
 */
async function refreshCreativeCopiesLive(deps: WorkerDeps, ctx: ReadToolContext): Promise<void> {
  const repo = createAnalysisRepo(deps.db);
  const account = await repo.loadAccount(ctx.orgId, ctx.adAccountId);
  if (!account) return;
  // Refresca só o TOP-N que será EXIBIDO (ranqueado do persistido), não a conta inteira: antes
  // listava TODOS os ads + getCreatives de todos → minutos numa conta grande, estourando o teto
  // do turno. Sem persistido (nunca analisou) → nada a refrescar (getTopCreativesData já é vazio).
  const persisted = await deps.db
    .select({ adId: adCreatives.adId, tier: adCreatives.tier, spend: adCreatives.spend, cpa: adCreatives.cpa, roas: adCreatives.roas })
    .from(adCreatives)
    .where(and(eq(adCreatives.adAccountId, ctx.adAccountId), eq(adCreatives.orgId, ctx.orgId)));
  const adIds = pickAdIdsToRefresh(persisted);
  if (adIds.length === 0) return;
  const ref = { adAccountId: account.metaAdAccountId, accessToken: deps.ports.vault.decrypt(account.tokenCripto) };
  const creatives = await deps.ports.ads.getCreatives(ref, adIds);
  const rows: AdCreativeCopyRow[] = creatives.map((c) => ({
    adId: c.adId,
    creativeId: c.id ?? null,
    name: c.name ?? null,
    body: c.body ?? null,
    title: c.title ?? null,
    callToAction: c.callToAction ?? null,
    imageUrl: c.imageUrl ?? null,
    imageHash: c.imageHash ?? null,
    thumbnailUrl: c.thumbnailUrl ?? null,
    videoId: c.videoId ?? null,
    // cache do destino WhatsApp (Fatia 7): CTA do criativo (`meta_cta`). Nome/página resolvem no
    // `getWhatsappDestination` ao vivo — este path de refresh é só copy/mídia. campaign_id/adset_id
    // vêm do RUN (join de entities); aqui ficam null e o upsert preserva o valor do run (coalesce).
    whatsappNumber: c.whatsappNumber ?? null,
    whatsappSource: c.whatsappNumber ? ("meta_cta" as const) : null,
    campaignId: null,
    adsetId: null,
  }));
  await repo.saveAdCreativeCopies(ctx.orgId, ctx.adAccountId, rows);
}

/**
 * Resolve o número de WhatsApp de destino de UMA campanha (Fatia 7) — DB-first (cache do
 * run em `ad_creatives`, escopado ao `campaign_id`), Meta ao vivo no fallback. Escopado à
 * campanha pedida: nunca devolve o número de outra entidade (a raiz do bug reportado).
 */
export async function resolveWhatsappNumber(
  deps: WorkerDeps,
  ctx: ReadToolContext,
  campaignId: string,
): Promise<WhatsappDestination> {
  const repo = createAnalysisRepo(deps.db);
  const account = await repo.loadAccount(ctx.orgId, ctx.adAccountId);
  if (!account) return { number: null, source: "none" };

  const cached = await deps.db
    .select({ number: adCreatives.whatsappNumber, source: adCreatives.whatsappSource })
    .from(adCreatives)
    .where(
      and(
        eq(adCreatives.orgId, ctx.orgId as OrgId),
        eq(adCreatives.adAccountId, ctx.adAccountId),
        eq(adCreatives.campaignId, campaignId),
        isNotNull(adCreatives.whatsappNumber),
      ),
    );
  // preferência: CTA autoritativo (meta_cta) > qualquer outro cacheado.
  const cta = cached.find((r) => r.source === "meta_cta" && r.number);
  if (cta?.number) return { number: cta.number, source: "meta_cta" };
  const other = cached.find((r) => r.number);
  if (other?.number) return { number: other.number, source: other.source ?? "campaign_name" };

  // fallback ao vivo (cobre página + campanhas fora do último run). Bounded + capturado: a Meta
  // lenta/errando NÃO pode derrubar o turno inteiro (era a raiz do "Não consegui processar" no
  // grupo) — degrada honesto p/ `none` (o render diz "não achei o número"), nunca lança.
  const ref = { adAccountId: account.metaAdAccountId, accessToken: deps.ports.vault.decrypt(account.tokenCripto) };
  try {
    return await withTimeout(deps.ports.ads.getWhatsappDestination(ref, campaignId), deps.conversation.liveFetchTimeoutMs);
  } catch {
    return { number: null, source: "none" };
  }
}

/**
 * Lista os custom audiences REAIS da conta (Fatia 7) — DB-first (cache do run), Meta ao vivo
 * no fallback (e re-cacheia). O agente para de CHUTAR público; propõe/segmenta com os reais.
 */
export async function listAudiencesData(
  deps: WorkerDeps,
  ctx: ReadToolContext,
): Promise<{ hasData: true; audiences: CustomAudience[] } | { hasData: false; note: string }> {
  const cached = await deps.db
    .select({
      externalId: customAudiences.externalId,
      name: customAudiences.name,
      subtype: customAudiences.subtype,
      approximateCount: customAudiences.approximateCount,
      isLookalike: customAudiences.isLookalike,
    })
    .from(customAudiences)
    .where(and(eq(customAudiences.orgId, ctx.orgId as OrgId), eq(customAudiences.adAccountId, ctx.adAccountId)))
    .orderBy(customAudiences.name);
  const toNeutral = (r: (typeof cached)[number]): CustomAudience => ({
    id: r.externalId,
    name: r.name,
    ...(r.subtype ? { subtype: r.subtype } : {}),
    ...(typeof r.approximateCount === "number" ? { approximateCount: r.approximateCount } : {}),
    isLookalike: r.isLookalike,
  });
  if (cached.length > 0) return { hasData: true, audiences: cached.map(toNeutral) };

  // fallback ao vivo + re-cacheia (a próxima consulta já vem do banco).
  const repo = createAnalysisRepo(deps.db);
  const account = await repo.loadAccount(ctx.orgId, ctx.adAccountId);
  if (!account) return { hasData: false, note: "conta não encontrada" };
  // bounded + capturado: Meta lenta/errando degrada honesto (não derruba o turno).
  const ref = { adAccountId: account.metaAdAccountId, accessToken: deps.ports.vault.decrypt(account.tokenCripto) };
  let live: CustomAudience[];
  try {
    live = await withTimeout(deps.ports.ads.listCustomAudiences(ref), deps.conversation.liveFetchTimeoutMs);
  } catch {
    return { hasData: false, note: "não consegui buscar os públicos agora — tenta de novo em instantes" };
  }
  if (live.length === 0) return { hasData: false, note: "não achei públicos salvos nessa conta" };
  await repo.saveCustomAudiences(ctx.orgId, ctx.adAccountId, live);
  return { hasData: true, audiences: live };
}

/**
 * Campanhas ATIVAS na Meta que ainda NÃO têm nenhuma linha em `entity_analyses` — o gap de
 * sincronização (pivô saúde): uma campanha recém-criada/ativada existe de verdade na Meta mas
 * só entra no cache curado na PRÓXIMA análise. Sem isso, list_campaigns/get_campaign_analysis
 * diriam "não existe"/omitiriam ela, quando na verdade só "ainda não foi medida". Bounded +
 * best-effort (mesmo padrão de `listCampaignsLive`): Meta lenta/indisponível degrada em lista
 * vazia — a resposta principal (do cache) já tinha o que tinha, isto é só um adendo honesto.
 */
export async function liveActiveCampaignsNotCached(
  deps: WorkerDeps,
  ctx: ReadToolContext,
  cachedIds: ReadonlySet<string>,
): Promise<Array<{ id: string; name: string }>> {
  const repo = createAnalysisRepo(deps.db);
  const account = await repo.loadAccount(ctx.orgId, ctx.adAccountId);
  if (!account) return [];
  const ref = { adAccountId: account.metaAdAccountId, accessToken: deps.ports.vault.decrypt(account.tokenCripto) };
  try {
    const entities = await withTimeout(deps.ports.ads.listEntities(ref, "campaign"), deps.conversation.liveFetchTimeoutMs);
    return entities.filter((e) => e.status === "active" && !cachedIds.has(e.id)).map((e) => ({ id: e.id, name: e.name }));
  } catch {
    return [];
  }
}

/**
 * Campanhas AO VIVO da Meta (id/nome/status) — fallback quando não há nada analisado ainda
 * (conta nova / campanhas pausadas nunca analisadas). "Analisadas primeiro, ao vivo no
 * fallback" (§Fatia 7): permite copiar/referenciar uma campanha mesmo sem run prévio.
 */
export async function listCampaignsLive(
  deps: WorkerDeps,
  ctx: ReadToolContext,
): Promise<{ hasData: true; live: true; campaigns: Array<{ id: string; name: string; status: string }> } | NoData> {
  const repo = createAnalysisRepo(deps.db);
  const account = await repo.loadAccount(ctx.orgId, ctx.adAccountId);
  if (!account) return { hasData: false, note: "conta não encontrada" };
  // bounded + capturado: Meta lenta/errando degrada honesto (não derruba o turno).
  const ref = { adAccountId: account.metaAdAccountId, accessToken: deps.ports.vault.decrypt(account.tokenCripto) };
  let entities;
  try {
    entities = await withTimeout(deps.ports.ads.listEntities(ref, "campaign"), deps.conversation.liveFetchTimeoutMs);
  } catch {
    return { hasData: false, note: "não consegui listar as campanhas agora — tenta de novo em instantes" };
  }
  if (entities.length === 0) return { hasData: false, note: "a conta não tem campanhas na Meta" };
  return { hasData: true, live: true, campaigns: entities.map((e) => ({ id: e.id, name: e.name, status: e.status })) };
}

/**
 * Status AO VIVO de UMA campanha (fresco — via `readEntityState`, que BATE na Meta e NÃO usa o
 * cache de entidades; o cache não invalida numa mudança feita direto no Ads Manager). Resolve por
 * id ou por nome (fuzzy). É a fonte da verdade pra "está ativa/pausada?" — o agente NUNCA deve
 * inferir status pelo GASTO (0 gasto ≠ pausada). Bounded: Meta lenta degrada honesto.
 */
export async function campaignStatusData(
  deps: WorkerDeps,
  ctx: ReadToolContext,
  input: { campaignId?: string; name?: string },
): Promise<{ hasData: true; campaigns: Array<{ id: string; name: string | null; status: string }>; source: "live" } | NoData> {
  const repo = createAnalysisRepo(deps.db);
  const account = await repo.loadAccount(ctx.orgId, ctx.adAccountId);
  if (!account) return { hasData: false, note: "conta não encontrada" };
  const ref = { adAccountId: account.metaAdAccountId, accessToken: deps.ports.vault.decrypt(account.tokenCripto) };

  // alvos a consultar: id explícito (1) OU as campanhas que casam com o nome. Ambíguo NÃO pede id —
  // devolve TODAS as que casaram (com o status ao vivo de cada) pro usuário escolher.
  let targets: Array<{ id: string; name: string | null }>;
  const explicitId = input.campaignId?.trim();
  if (explicitId) {
    targets = [{ id: explicitId, name: null }];
  } else {
    if (!input.name?.trim()) return { hasData: false, note: "me diga o id ou o nome da campanha" };
    let live;
    try {
      live = await withTimeout(deps.ports.ads.listEntities(ref, "campaign"), deps.conversation.liveFetchTimeoutMs);
    } catch {
      return { hasData: false, note: "não consegui buscar a campanha agora — tenta de novo em instantes" };
    }
    const m = resolveNamedMatch(live, input.name, { name: (e) => e.name, keys: (e) => [e.id] });
    if (m.kind === "none") return { hasData: false, note: `não achei uma campanha com "${input.name}"` };
    targets = m.kind === "one" ? [{ id: m.row.id, name: m.row.name }] : m.rows.map((e) => ({ id: e.id, name: e.name }));
  }

  // STATUS FRESCO de cada alvo (readEntityState não passa pelo cache → reflete reativação/pausa
  // externa AGORA). Bounded (resolveNamedMatch já capa a lista). Falha numa → pula só ela.
  const campaigns: Array<{ id: string; name: string | null; status: string }> = [];
  for (const t of targets) {
    try {
      const raw = await withTimeout(deps.ports.ads.readEntityState(ref, t.id), deps.conversation.liveFetchTimeoutMs);
      campaigns.push({ id: t.id, name: t.name, status: mapStatus(raw["effective_status"] as string | undefined, raw["status"] as string | undefined) });
    } catch {
      /* pula essa — best-effort */
    }
  }
  if (campaigns.length === 0) return { hasData: false, note: "não consegui confirmar o status ao vivo agora — tenta de novo em instantes" };
  return { hasData: true, campaigns, source: "live" };
}

/**
 * Renderiza o número + origem de forma HONESTA e DETERMINÍSTICA (emitido verbatim pela
 * casca — o LLM não digita os dígitos, então não pode misatribuir). `meta_promoted_object`/
 * `meta_cta`/`meta_page` = confiante; `campaign_name` = pede confirmação (o nome não é
 * autoritativo); `none` = não consta + próximo passo.
 */
export function renderWhatsappNumber(dest: WhatsappDestination, campaignLabel: string): string {
  const alvo = `da campanha *${campaignLabel}*`;
  if (dest.source === "none" || !dest.number) {
    return `Não achei o número de WhatsApp de destino ${alvo} nos dados que tenho. Dá pra conferir direto no Gerenciador de Anúncios.`;
  }
  if (dest.source === "campaign_name") {
    return `No *nome* ${alvo} aparece o número *${dest.number}* — mas isso vem do nome da campanha, não do destino configurado, então não é 100% confiável. Confirma que é esse mesmo?`;
  }
  return `O WhatsApp de destino ${alvo} é *${dest.number}*.`;
}

/**
 * Monta as 5 tools de LEITURA do turno (todas org-scoped, read-only sobre o nosso
 * DB curado). Seguro executar direto — não há escrita nem chamada à plataforma.
 */
/** Aprendizados curados do agente (não arquivados) — transparência conversacional (S7). */
export async function getLearningsData(db: WorkerDeps["db"], orgId: string, agentId: string) {
  const rows = await db
    .select({ id: agentMemory.id, content: agentMemory.content, confidence: agentMemory.confidence, origin: agentMemory.origin, confirmedByHuman: agentMemory.confirmedByHuman, proposedThresholdPatch: agentMemory.proposedThresholdPatch })
    .from(agentMemory)
    .where(
      and(
        eq(agentMemory.orgId, orgId),
        eq(agentMemory.agentId, agentId),
        inArray(agentMemory.type, [...LEARNING_MEMORY_TYPES]),
        isNotNull(agentMemory.semanticKey),
        sql`${agentMemory.lifecycle} <> 'archived'`,
      ),
    )
    .orderBy(desc(agentMemory.confirmedByHuman), desc(agentMemory.confidence))
    .limit(12);
  if (rows.length === 0) return { hasData: false, note: "ainda não aprendi nada específico desta conta" };
  return {
    hasData: true,
    // `id` é a referência que as tools de controle (confirm/forget/approve/reject) consomem —
    // sem ele o LLM não tem como agir sobre um aprendizado específico. `hasProposal` diz quais
    // têm proposta de ajuste pendente (alvo do approve_proposal/reject_proposal).
    learnings: rows.map((r) => ({
      id: r.id,
      content: r.content,
      confidence: confidenceTier(r.confidence ?? 0, r.confirmedByHuman),
      origin: r.origin,
      confirmed: r.confirmedByHuman,
      hasProposal: r.proposedThresholdPatch != null,
    })),
  };
}

export function makeReadTools(deps: WorkerDeps, ctx: ReadToolContext) {
  const { db, ports, logger } = deps;

  // Self-guard (S6 — always-bind em grupo multi-conta): as tools account-scoped ficam
  // BOUND mesmo sem foco (concierge-start em grupo), mas sem conta em contexto respondem
  // pedindo o foco em vez de consultar com adAccountId vazio (dado errado). O LLM então
  // dá set_focus (do explícito/ambiente) → muta o ctx → re-chama e responde no mesmo turno.
  const NEEDS_FOCUS =
    'Me diga primeiro em qual conta (a organização tem várias). Ex: "foca na Loja X" — ou só o nome que eu identifico.';
  /** Sem conta em contexto (concierge-start) → pede o foco em vez de consultar vazio. */
  const noFocus = () => !ctx.adAccountId;

  const listLearnings = tool(
    async () => {
      if (noFocus()) return NEEDS_FOCUS;
      logger.debug({ agentId: ctx.agentId }, "tool:list_learnings");
      return asString(await getLearningsData(db, ctx.orgId, ctx.agentId));
    },
    {
      name: "list_learnings",
      description:
        "O que você APRENDEU observando esta conta ao longo das análises (padrões recorrentes, o que funcionou/não deu certo). Use quando o dono perguntar 'o que você aprendeu?', 'o que você já sabe da minha conta?', 'você aprende comigo?'. Cada item traz a confiança (explorando/provável/confirmado) e a origem. NÃO invente aprendizados fora desta lista; se vier vazio, diga com honestidade que ainda está conhecendo a conta.",
      schema: z.object({}),
    },
  );

  const getAccountStatus = tool(
    async () => {
      if (noFocus()) return NEEDS_FOCUS;
      logger.debug({ agentId: ctx.agentId }, "tool:get_account_status");
      return asString(await getAccountStatusData(db, ctx.agentId, ctx.orgId, ports.approval));
    },
    {
      name: "get_account_status",
      description:
        "DESEMPENHO da conta pela última análise concluída: nota, resumo, gasto, DESPERDÍCIO (waste: quanto está queimando em campanhas paradas e onde o gasto está mal alocado — lidere por isso quando houver), nº de recomendações e de aprovações pendentes, e 'asOf' = QUANDO essa análise rodou (a data/hora do dado). Esta é a tool PADRÃO pra perguntas genéricas de 'como está a conta?' / 'como estamos indo?' (é sobre resultado, NÃO a situação administrativa na Meta — pra desativação/saldo/pagamento use get_account_health). Também responde 'esse dado é de hoje? / de quando é essa análise?': cite o 'asOf'. Quando vier 'partialNote', essa análise ficou INCOMPLETA (a Meta limitou temporariamente ou uma parte degradou) — sempre repasse esse aviso ao dono, nunca omita.",
      schema: z.object({}),
    },
  );

  const getMetrics = tool(
    async ({ periodDays }: { periodDays?: number | null }) => {
      if (noFocus()) return NEEDS_FOCUS;
      const days = periodDays ?? DEFAULT_METRICS_PERIOD_DAYS;
      logger.debug({ adAccountId: ctx.adAccountId, periodDays: days }, "tool:get_metrics");
      return asString(await getMetricsData(db, ctx.adAccountId, ctx.orgId, ctx.agentId, days, ctx.timezone));
    },
    {
      name: "get_metrics",
      description:
        "Gasto, conversões, CPA, ROAS e receita da conta (ou campanha, se ela for a única com dado) em QUALQUER período JÁ SINCRONIZADO — SEM limite de 7 dias (usa o último dado salvo, pode estar até 1 dia desatualizado; sem chamada nova à Meta). Traz 'asOf' = a data do dado mais recente somado. Use para períodos LONGOS (ex: 'últimos 10/30 dias', 'esse mês'). Pra dado mais atual e recente (hoje/ontem/últimos dias ≤7d), prefira get_fresh_metrics.",
      // nullable+optional: structured-output exige que campo omissível seja nullable.
      schema: z.object({ periodDays: z.number().int().positive().nullable().optional() }),
    },
  );

  const getFreshMetrics = tool(
    async ({
      periodDays,
      sinceDaysAgo,
      untilDaysAgo,
      campaign,
    }: {
      periodDays?: number | null;
      sinceDaysAgo?: number | null;
      untilDaysAgo?: number | null;
      campaign?: string | null;
    }) => {
      if (noFocus()) return NEEDS_FOCUS;
      logger.debug(
        { adAccountId: ctx.adAccountId, periodDays, sinceDaysAgo, untilDaysAgo, campaign },
        "tool:get_fresh_metrics",
      );
      return asString(
        await getFreshMetricsData(
          { db, vault: ports.vault, insightsSync: deps.insightsSync, ads: ports.ads, logger },
          { orgId: ctx.orgId, agentId: ctx.agentId, adAccountId: ctx.adAccountId, timezone: ctx.timezone },
          {
            periodDays: periodDays ?? null,
            sinceDaysAgo: sinceDaysAgo ?? null,
            untilDaysAgo: untilDaysAgo ?? null,
            campaign: campaign ?? null,
          },
        ),
      );
    },
    {
      name: "get_fresh_metrics",
      description:
        "Puxa métricas ATUALIZADAS da Meta (gasto, resultados, CPA/ROAS, CPC/CPM) da conta em QUALQUER recorte dentro dos últimos 7 dias. Recorte em DIAS ATRÁS (0=hoje, 1=ontem…): `untilDaysAgo` = fim da janela; `sinceDaysAgo` = início (mais antigo, >= untilDaysAgo). Exemplos: HOJE → {} (default); ONTEM fechado → {untilDaysAgo:1}; últimos 3 dias → {periodDays:3}; de 3 dias atrás até 2 dias atrás → {sinceDaysAgo:3, untilDaysAgo:2}. `periodDays` é atalho p/ 'últimos N dias terminando no fim'. Se citar o nome de uma campanha, traz a dela. Se a Meta estiver indisponível/limitada, cai no último dado sincronizado (updated=false — avise); sem dado do período nem no salvo, o campo error explica. Período MAIOR que 7 dias → use get_metrics (dado salvo, sem chamada nova à Meta).",
      schema: z.object({
        periodDays: z.number().int().positive().nullable().optional(),
        sinceDaysAgo: z.number().int().min(0).nullable().optional(),
        untilDaysAgo: z.number().int().min(0).nullable().optional(),
        campaign: z.string().nullable().optional(),
      }),
    },
  );

  const getCampaignAnalysis = tool(
    async ({ name }: { name: string }) => {
      if (noFocus()) return NEEDS_FOCUS;
      logger.debug({ agentId: ctx.agentId, name }, "tool:get_campaign_analysis");
      const result = await getCampaignAnalysisData(db, ctx.agentId, name);
      // "não achei" pode ser "não existe" OU "existe e está ATIVA na Meta, só nunca foi
      // analisada" (gap de sincronização) — nunca dizer a 1ª sem checar a 2ª. `hasData` só
      // existe em NoData/AmbiguousCampaign (CampaignAnalysis não tem o campo) — combinado com
      // "sem ambiguous" isola exatamente o caso NoData (várias casando já é tratado à parte).
      if ("hasData" in result && !("ambiguous" in result)) {
        const gaps = await liveActiveCampaignsNotCached(deps, ctx, new Set());
        const match = resolveNamedMatch(gaps, name, { name: (g) => g.name, keys: (g) => [g.id] });
        if (match.kind === "one") {
          return asString({
            hasData: true,
            id: match.row.id,
            name: match.row.name,
            noDataYet: true,
            note: "Essa campanha existe e está ATIVA na Meta agora, mas ainda não tem NENHUMA análise — nenhum tier/orçamento/métrica disponível. Diga que ela existe/está ativa e ofereça rodar uma análise; nunca invente um número pra ela.",
          });
        }
      }
      return asString(result);
    },
    {
      name: "get_campaign_analysis",
      description:
        "Última análise de uma campanha pelo nome (busca por trecho, sem diferenciar maiúsculas). Devolve o id (use-o para agir), resumo, métricas curadas, o maior gargalo, o tier (winner/performer/underperformer/zombie), healthSignals (fadiga/saturação/pouco dado/criativo fraco), audience (estágio: prospecção/remarketing), funnel (conversas/1ª resposta/profundidade — qualidade do lead), conversionBasis ('target' = a conversão mostrada É a de negócio; 'proxy' = referência, a venda não é rastreada ali; 'none' = sem conversão), benchmarkRef (referência de plataforma, só cold-start) e o ORÇAMENTO (budget: diário ou vitalício; atBudgetCeiling: true = sem folga pra gastar mais sem subir o orçamento; isCBO: true = orçamento na própria campanha, false = por conjunto/adset — nesse caso qualquer mudança é POR CONJUNTO). Campanha ABO (isCBO=false) com 2+ conjuntos com diagnóstico próprio também traz 'adsets' (id/nome/tier de cada conjunto) + 'adsetsNote' explicando por que a campanha não tem um tier único — cite os dois ao comentar o desempenho dela, não silencie a diferença. Campos vêm null/ausentes quando a conta não foi reanalisada desde que esse dado passou a ser coletado — nesse caso, não afirme 'sem dado', diga que precisa rodar uma nova análise. Sem nenhuma análise casando o nome, verifica AO VIVO se a campanha existe ATIVA na Meta (noDataYet:true) antes de dizer que não existe. 'deactivatedSince' presente = a Meta não lista mais essa campanha como ativa desde essa data — o resto do curado (tier/métricas) é da ÚLTIMA vez que ela esteve ativa, NÃO é o estado atual; avise isso sempre que citar dado dela, nunca apresente como se estivesse rodando agora.",
      schema: z.object({ name: z.string() }),
    },
  );

  const getCampaignStatus = tool(
    async ({ campaignId, name }: { campaignId?: string; name?: string }) => {
      if (noFocus()) return NEEDS_FOCUS;
      logger.debug({ agentId: ctx.agentId, campaignId, name }, "tool:get_campaign_status");
      return asString(await campaignStatusData(deps, ctx, { ...(campaignId ? { campaignId } : {}), ...(name ? { name } : {}) }));
    },
    {
      name: "get_campaign_status",
      description:
        "Status AO VIVO (ativa/pausada) direto da Meta AGORA — por id ou nome. Devolve uma LISTA de campanhas que casaram (com o status de cada): nome único → 1; nome ambíguo → TODAS as parecidas com o status — MOSTRE a lista pro usuário (não peça o id de volta). É a ÚNICA fonte confiável de ativa/pausada: NUNCA deduza por gasto (0 gasto ≠ pausada). Use SEMPRE antes de recomendar reativar/pausar/substituir (a análise pode ter horas) e quando o usuário afirmar que uma campanha está ativa/pausada (confirme ao vivo, não só concorde).",
      schema: z.object({
        campaignId: z.string().nullable().optional().describe("id da campanha (preferido; use get_campaign_analysis/list_campaigns pra achar)"),
        name: z.string().nullable().optional().describe("nome (ou trecho) da campanha — usado se não tiver o id; ambíguo → peço o id"),
      }),
    },
  );

  const listCampaigns = tool(
    async ({
      periodDays,
      sinceDaysAgo,
      untilDaysAgo,
    }: {
      periodDays?: number | null;
      sinceDaysAgo?: number | null;
      untilDaysAgo?: number | null;
    }) => {
      if (noFocus()) return NEEDS_FOCUS;
      const hasPeriod = periodDays != null || sinceDaysAgo != null || untilDaysAgo != null;
      logger.debug({ agentId: ctx.agentId, periodDays, sinceDaysAgo, untilDaysAgo, hasPeriod }, "tool:list_campaigns");
      // COM período → breakdown FRESH dos snapshots por campanha na janela (nomes via Meta);
      // SEM período → última análise curada (com tier/achados).
      if (hasPeriod) {
        return asString(
          await getCampaignsBreakdownData(
            { db, vault: ports.vault, insightsSync: deps.insightsSync, ads: ports.ads, logger },
            { orgId: ctx.orgId, agentId: ctx.agentId, adAccountId: ctx.adAccountId, timezone: ctx.timezone },
            { periodDays: periodDays ?? null, sinceDaysAgo: sinceDaysAgo ?? null, untilDaysAgo: untilDaysAgo ?? null },
          ),
        );
      }
      // analisadas primeiro (curadas, com tier/métrica); sem nenhuma analisada → ao vivo
      // (id/nome/status) pra o agente ainda conseguir referenciar/copiar (Fatia 7).
      const analyzed = await listCampaignsData(db, ctx.agentId);
      if (analyzed.hasData) {
        // gap de sincronização (pivô saúde): campanha ATIVA na Meta sem NENHUMA análise ainda —
        // nunca omitir, nunca inventar número; entra na lista marcada "sem dado ainda".
        const knownIds = new Set(analyzed.campaigns.map((c) => c.id));
        const gaps = await liveActiveCampaignsNotCached(deps, ctx, knownIds);
        if (gaps.length > 0) {
          return asString({
            ...analyzed,
            campaigns: [
              ...analyzed.campaigns,
              ...gaps.map((g) => ({ id: g.id, name: g.name, spend: null, conversions: null, cpa: null, roas: null, revenue: null, ...curatedViewOf(null), noDataYet: true })),
            ],
            syncNote: `${gaps.length} campanha(s) ativa(s) na Meta (${gaps.map((g) => g.name).join(", ")}) ainda NÃO têm nenhuma análise — os campos delas vêm vazios (noDataYet:true) até rodar uma análise nova; cite explicitamente que elas existem e estão ativas, sem inventar número.`,
          });
        }
        return asString(analyzed);
      }
      return asString(await listCampaignsLive(deps, ctx));
    },
    {
      name: "list_campaigns",
      description:
        "TODAS as campanhas da conta com métricas por campanha (gasto, conversões, CPA, ROAS, receita), ordenadas por gasto — pra COMPARAR/ALOCAR verba ('quais gastam mais e convertem pior', 'onde cortar/proteger', 'valores por campanha', 'qual o orçamento de cada campanha'). SEM args = última análise curada (inclui tier/diagnóstico e o ORÇAMENTO de cada campanha: budget/atBudgetCeiling/isCBO — mesmos campos de get_campaign_analysis; null quando a conta não foi reanalisada desde que esse dado passou a ser coletado, nesse caso ofereça rodar uma análise em vez de dizer 'sem orçamento'). Também verifica AO VIVO se existe campanha ATIVA na Meta ainda sem nenhuma análise — vem marcada noDataYet:true + 'syncNote'; cite que ela existe/está ativa, nunca invente número pra ela. Uma campanha com 'deactivatedSince' preenchido saiu do conjunto ativo desde essa data — mencione isso, nunca trate o tier/métricas dela como situação atual. COM recorte de período (mesmo formato do get_fresh_metrics: periodDays, ou sinceDaysAgo+untilDaysAgo em dias atrás, 0=hoje/1=ontem, ≤7d) = dados FRESH agregados por campanha na janela (SEM orçamento — isso só vem da análise curada, sem args). É a divisão por campanha que o get_fresh_metrics (agregado da conta) não dá.",
      schema: z.object({
        periodDays: z.number().int().positive().nullable().optional(),
        sinceDaysAgo: z.number().int().min(0).nullable().optional(),
        untilDaysAgo: z.number().int().min(0).nullable().optional(),
      }),
    },
  );

  const findRecentActions = tool(
    async ({ name }: { name?: string | null }) => {
      if (noFocus()) return NEEDS_FOCUS;
      logger.debug({ agentId: ctx.agentId, name }, "tool:find_recent_actions");
      return asString(await findRecentActionsData(db, ctx.agentId, name ? { nameFilter: name } : {}));
    },
    {
      name: "find_recent_actions",
      description:
        "Ações recentes que VOCÊ aplicou e que dá pra desfazer (id, tipo, campanha, quando). Use para 'desfaz isso' (a mais recente) ou 'desfaz a pausa da X' (filtra por nome). Passe o id para revert_action.",
      schema: z.object({ name: z.string().nullable().optional() }),
    },
  );

  const listRecommendations = tool(
    async () => {
      if (noFocus()) return NEEDS_FOCUS;
      logger.debug({ agentId: ctx.agentId }, "tool:list_recommendations");
      const base = await listRecommendationsData(db, ctx.agentId, ctx.orgId);
      // enriquecimento DETERMINÍSTICO: anexa o status AO VIVO das campanhas das recs dependentes de
      // status (não depende do LLM chamar get_campaign_status). Best-effort/bounded.
      const data = base.hasData ? await enrichRecommendationsLiveStatus(deps, ctx, base) : base;
      return asString(data);
    },
    {
      name: "list_recommendations",
      description:
        "Recomendações da última análise concluída (título, motivo, risco) + asOf (quando rodou). Recs dependentes de status (reativar/pausar/substituir) já vêm com liveStatus (ativa/pausada AO VIVO) da campanha — use SEMPRE o liveStatus, não o texto, pra dizer se está ativa/pausada.",
      schema: z.object({}),
    },
  );

  const listPending = tool(
    async () => {
      logger.debug({ orgId: ctx.orgId }, "tool:list_pending");
      return asString(await listPendingData(db, ports.approval, ctx.orgId));
    },
    {
      name: "list_pending",
      description: "Ações aguardando aprovação na organização (todas as contas).",
      schema: z.object({}),
    },
  );

  const listAccounts = tool(
    async () => {
      logger.debug({ orgId: ctx.orgId }, "tool:list_accounts");
      return asString(await listAccountsData(db, ctx.orgId));
    },
    {
      name: "list_accounts",
      description:
        `Panorama das contas ativas da org: as até ${PORTFOLIO_OVERVIEW_MAX_ACCOUNTS} que mais precisam de atenção vêm com nome, nota e gasto da última análise concluída (pior nota primeiro); as demais vêm só o nome, em otherAccountNames (sem detalhe, mas NUNCA omitidas). Contas sem análise ainda vêm com hasData:false — não omita, não invente dado. Use pra 'quantas contas eu tenho' / 'quais contas eu tenho' / 'como estão minhas contas'.`,
      schema: z.object({}),
    },
  );

  const comparePeriods = tool(
    async ({ periodDays }: { periodDays?: number | null }) => {
      if (noFocus()) return NEEDS_FOCUS;
      const days = periodDays ?? DEFAULT_METRICS_PERIOD_DAYS;
      logger.debug({ adAccountId: ctx.adAccountId, periodDays: days }, "tool:compare_periods");
      return asString(await comparePeriodsData(db, ctx.adAccountId, ctx.orgId, days, ctx.timezone));
    },
    {
      name: "compare_periods",
      description: "Compara o gasto da conta em duas janelas contíguas (esta vs a anterior de N dias) + variação %.",
      schema: z.object({ periodDays: z.number().int().positive().nullable().optional() }),
    },
  );

  const getEntityDetail = tool(
    async ({ name }: { name: string }) => {
      if (noFocus()) return NEEDS_FOCUS;
      logger.debug({ agentId: ctx.agentId, name }, "tool:get_entity_detail");
      return asString(await getEntityDetailData(db, ctx.agentId, ctx.adAccountId, ctx.orgId, name, ctx.timezone));
    },
    {
      name: "get_entity_detail",
      description:
        "Detalha uma campanha pelo nome: tendência diária de gasto + flags + o MESMO diagnóstico curado de get_campaign_analysis (tier/budget/healthSignals/audience/funnel/conversionBasis/benchmarkRef/deactivatedSince; ABO multi-adset também traz 'adsets'/'adsetsNote'). Use para 'como o gasto da X evoluiu' e pra aprofundar num diagnóstico já citado.",
      schema: z.object({ name: z.string() }),
    },
  );

  const getAgentConfig = tool(
    async () => {
      if (noFocus()) return NEEDS_FOCUS;
      logger.debug({ agentId: ctx.agentId }, "tool:get_agent_config");
      return asString(await getAgentConfigData(db, ctx.orgId, ctx.agentId));
    },
    {
      name: "get_agent_config",
      description:
        "Como o agente está configurado hoje: objetivo/meta, autonomia, guardrails e AVISOS proativos (pulso, alerta, reativação, saúde da conta — incluindo quais estados avisam, o teto de gasto e o limiar de SALDO baixo, com os valores reais). Use pra responder sobre a configuração atual (ex: 'qual meu alerta de saldo?') — cite o valor REAL daqui, nunca invente. Mudar = por conversa (set_notifications e afins) ou pelo site.",
      schema: z.object({}),
    },
  );

  const explainRecommendation = tool(
    async ({ title }: { title: string }) => {
      if (noFocus()) return NEEDS_FOCUS;
      logger.debug({ agentId: ctx.agentId, title }, "tool:explain_recommendation");
      return asString(await explainRecommendationData(db, ctx.agentId, ctx.orgId, title));
    },
    {
      name: "explain_recommendation",
      description:
        "Explica uma recomendação da última análise (por trecho do título): motivo e nível de risco, e quando disponível o impacto esperado em R$ (expectedImpact) e o que acompanhar depois de aplicar (whatToMonitor) — ambos vêm null quando o analista não tinha dado suficiente pra estimar; não invente um valor quando vier null.",
      schema: z.object({ title: z.string() }),
    },
  );

  const getTopCreatives = tool(
    async ({ fresh }: { fresh?: boolean | null }) => {
      if (noFocus()) return NEEDS_FOCUS;
      logger.debug({ agentId: ctx.agentId, fresh: Boolean(fresh) }, "tool:get_top_creatives");
      // fresh = puxa a copy ATUAL da Meta antes de responder (preserva a perf do run). Sob teto
      // de tempo próprio (< turnTimeout): Meta lenta → degrada pro persistido em vez de estourar
      // o turno inteiro (a causa do fallback genérico quando o refresh levava minutos).
      if (fresh) {
        await withTimeout(refreshCreativeCopiesLive(deps, ctx), deps.conversation.liveFetchTimeoutMs).catch((err) =>
          logger.warn({ err: String(err) }, "get_top_creatives:refresh live degradou (usa persistido)"),
        );
      }
      return asString(await getTopCreativesData(db, ctx.adAccountId, ctx.orgId));
    },
    {
      name: "get_top_creatives",
      description:
        "Os melhores criativos da conta (copy: texto principal, título, CTA) ranqueados por desempenho. Use para 'qual minha copy campeã' ou para embasar direção de criativo. Passe fresh=true para buscar as copies ATUAIS na Meta em tempo real; senão usa as do último run. SEM receita/conversão por anúncio — pra 'quais anúncios trouxeram essa receita'/'separar por criativo' (financeiro), use get_ads_breakdown.",
      schema: z.object({ fresh: z.boolean().nullable() }),
    },
  );

  const getAccountHealth = tool(
    async ({ fresh }: { fresh?: boolean | null }) => {
      if (noFocus()) return NEEDS_FOCUS;
      logger.debug({ agentId: ctx.agentId, fresh: Boolean(fresh) }, "tool:get_account_health");
      if (fresh) {
        await withTimeout(refreshAccountHealthLive(deps, ctx), deps.conversation.liveFetchTimeoutMs).catch((err) =>
          logger.warn({ err: String(err) }, "get_account_health:refresh live degradou (usa persistido)"),
        );
      }
      return asString(await getAccountHealthData(db, ctx.adAccountId, ctx.orgId, logger));
    },
    {
      name: "get_account_health",
      description:
        "Situação ADMINISTRATIVA da conta NA PRÓPRIA META: se foi desativada, token de acesso, saldo, teto de gasto e pagamento. NÃO é desempenho. Pergunta genérica como 'como está a conta?' / 'como estamos indo?' é DESEMPENHO → use get_account_status, NÃO esta. Use esta SÓ quando o dono perguntar especificamente: a conta foi desativada?, por que os anúncios pararam de rodar?, qual meu saldo/teto?, tem problema de pagamento?. NÃO chame 'por garantia' — problema crítico já chega por alerta automático. fresh=true busca o estado ATUAL na Meta; senão usa o último sincronizado. Se 'tokenExpired' vier true, o acesso expirou — oriente reconectar no site. Saldo/gasto/teto (quando vierem) você PODE repassar; só o rótulo do cartão/pagamento fica no site (atrás de login), nunca por aqui.",
      schema: z.object({ fresh: z.boolean().nullable() }),
    },
  );

  const listAudiences = tool(
    async () => {
      if (noFocus()) return NEEDS_FOCUS;
      logger.debug({ agentId: ctx.agentId }, "tool:list_audiences");
      return asString(await listAudiencesData(deps, ctx));
    },
    {
      name: "list_audiences",
      description:
        "Lista os públicos (custom audiences) REAIS da conta — id, nome, tamanho aproximado e se é lookalike. Use pra propor remarketing/exclusões com base nos públicos que EXISTEM (nunca invente público). Necessário antes de segmentar uma campanha por público.",
      schema: z.object({}),
    },
  );

  const getAdsBreakdown = tool(
    async ({
      periodDays,
      sinceDaysAgo,
      untilDaysAgo,
      campaign,
    }: {
      periodDays?: number | null;
      sinceDaysAgo?: number | null;
      untilDaysAgo?: number | null;
      campaign?: string | null;
    }) => {
      if (noFocus()) return NEEDS_FOCUS;
      logger.debug(
        { adAccountId: ctx.adAccountId, periodDays, sinceDaysAgo, untilDaysAgo, campaign },
        "tool:get_ads_breakdown",
      );
      const result: FreshAdsBreakdown | { error: string } = await getAdsBreakdownData(
        { db, vault: ports.vault, insightsSync: deps.insightsSync, ads: ports.ads, logger },
        { orgId: ctx.orgId, agentId: ctx.agentId, adAccountId: ctx.adAccountId, timezone: ctx.timezone },
        {
          periodDays: periodDays ?? null,
          sinceDaysAgo: sinceDaysAgo ?? null,
          untilDaysAgo: untilDaysAgo ?? null,
          campaign: campaign ?? null,
        },
      );
      return asString(result);
    },
    {
      name: "get_ads_breakdown",
      description:
        "Gasto, conversões, CPA, ROAS e RECEITA POR ANÚNCIO (separado por criativo) em QUALQUER período JÁ SINCRONIZADO — SEM limite de 7 dias, dado salvo (sem chamada nova à Meta). Use para 'quais anúncios trouxeram essa receita', 'separar por criativo', 'qual anúncio converteu mais'. Sem `campaign`, traz os top 10 anúncios da conta por gasto; com `campaign` (nome), traz TODOS os anúncios daquela campanha. Mesmo formato de período do get_fresh_metrics (periodDays/sinceDaysAgo/untilDaysAgo em dias atrás), sem o cap de 7d. SEM copy/texto do criativo — pra isso use get_top_creatives.",
      schema: z.object({
        periodDays: z.number().int().positive().nullable().optional(),
        sinceDaysAgo: z.number().int().min(0).nullable().optional(),
        untilDaysAgo: z.number().int().min(0).nullable().optional(),
        campaign: z.string().nullable().optional(),
      }),
    },
  );

  const getPendingDraft = tool(
    async () => {
      if (noFocus()) return NEEDS_FOCUS;
      logger.debug({ agentId: ctx.agentId }, "tool:get_pending_draft");
      return asString(await getPendingDraftData(db, ports.approval, ctx.orgId, ctx.agentId, ctx.adAccountId));
    },
    {
      name: "get_pending_draft",
      description:
        "Detalhe do RASCUNHO de campanha aguardando sua aprovação (do banco, sempre atual — não expira em 30min como o eco): QUAL criativo (anúncio real), QUAL público, e as copies, com o id pra aprovar/recusar. Use quando o usuário perguntar sobre a campanha que você propôs ('qual público', 'qual criativo', 'o que você vai criar', 'recusa/aprova o rascunho'). Responde na hora, sem chamar a Meta.",
      schema: z.object({}),
    },
  );

  return [
    listLearnings,
    getAccountStatus,
    getMetrics,
    getFreshMetrics,
    getCampaignAnalysis,
    getCampaignStatus,
    listCampaigns,
    getEntityDetail,
    comparePeriods,
    findRecentActions,
    listRecommendations,
    listPending,
    getPendingDraft,
    listAccounts,
    getAgentConfig,
    explainRecommendation,
    getTopCreatives,
    getAccountHealth,
    getAdsBreakdown,
    listAudiences,
  ];
}
