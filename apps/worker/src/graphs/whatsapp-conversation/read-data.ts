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

import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { adAccounts, agentRuns, agentToolCalls, agents, entityAnalyses, insightsSnapshots, recommendations } from "@trafego/db";
import type { Database } from "@trafego/db/client";
import { createAnalysisRepo } from "../../modules/analysis/repo.js";
import { getFreshMetricsData } from "../../modules/conversation/fresh-metrics.js";
import type { ApprovalPort } from "@trafego/shared/ports";
import { UNDO_BLOCKED_TOOL_KEY, UNDO_TOOL_KEY } from "@trafego/shared";
import type { EntityLevel, InsightMetrics, OrgId, UnitAnalysis } from "@trafego/shared";
import type { WorkerDeps } from "../../composition.js";

/** Contexto do turno (tenant/conta resolvidos no início) — injetado nas tools. */
export interface ReadToolContext {
  readonly orgId: string;
  readonly agentId: string;
  readonly adAccountId: string;
  readonly contactId: string;
}

/** Janela default do gasto agregado (dias). */
const DEFAULT_METRICS_PERIOD_DAYS = 7;
/** Runs "finalizados" que contam como a última análise concluída (mirror da API). */
const FINISHED_RUN_STATUSES = ["succeeded", "failed"] as const;
/** Nível mais alto do gasto agregado; cai p/ campanha quando não há linha de conta. */
const ACCOUNT_LEVEL: EntityLevel = "account";
const CAMPAIGN_LEVEL: EntityLevel = "campaign";
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
}

interface AccountMetrics {
  readonly periodDays: number;
  readonly spend: number;
  readonly asOf: string;
  readonly hasData: boolean;
}

interface CampaignAnalysis {
  /** id da campanha na plataforma — o agente usa p/ agir (pausar/budget) no chat (5c). */
  readonly id: string;
  readonly name: string | null;
  readonly spend?: number;
  readonly cpa?: number;
  readonly roas?: number;
  readonly summary: string | null;
  readonly topFinding: { readonly title: string; readonly severity: string } | null;
  readonly flags: readonly string[];
  readonly asOf: string;
}

/** Várias campanhas casaram o nome → o agente desambigua. */
interface AmbiguousCampaign {
  readonly hasData: false;
  readonly ambiguous: true;
  readonly matches: readonly string[];
  readonly note: string;
}

interface RecommendationItem {
  readonly title: string;
  readonly rationale: string | null;
  readonly riskLevel: string;
}

interface PendingItem {
  /** id da aprovação — o agente referencia por ele ao aprovar/rejeitar (5b-2.3). */
  readonly id: string;
  readonly entityLevel: string;
  readonly entityId: string;
  readonly entityName: string | null;
  readonly actionType: string;
  readonly reason: string;
  readonly expiresAt: string;
}

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
  return {
    grade: snap?.scorecard?.grade ?? null,
    headline: snap?.scorecard?.headline ?? null,
    summary: run.summary ?? null,
    ...(typeof spend === "number" ? { spend } : {}),
    ...(waste ? { waste } : {}),
    recommendationCount: recIds.length,
    pendingCount: pending.length,
    asOf: (run.finishedAt ?? run.createdAt).toISOString(),
  };
}

/** Linha do panorama — versão enxuta de `AccountStatus` (sem recomendação/pendência,
 *  que é detalhe por-conta; aqui o objetivo é "quais contas, como cada uma está indo"). */
interface PortfolioAccountEntry {
  readonly accountName: string | null;
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
    .select({ agentId: agents.id, accountName: adAccounts.name })
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
    if (!run) return { accountName: r.accountName, hasData: false, grade: null, headline: null, asOf: ASOF_NONE };
    const snap = (run.metricsSnapshot ?? null) as RunMetricsSnapshot | null;
    const spend = snap?.kpis?.spend;
    return {
      accountName: r.accountName,
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
  periodDays: number,
  now: () => Date = () => new Date(),
): Promise<AccountMetrics> {
  const since = formatDate(daysAgo(now(), periodDays));
  const accountRows = await spendRows(db, adAccountId, orgId, ACCOUNT_LEVEL, since);
  const rows = accountRows.length > 0 ? accountRows : await spendRows(db, adAccountId, orgId, CAMPAIGN_LEVEL, since);

  if (rows.length === 0) return { periodDays, spend: 0, asOf: ASOF_NONE, hasData: false };

  const spend = rows.reduce((sum, r) => sum + spendOf(r.metricsJson), 0);
  const asOf = rows.reduce((latest, r) => (r.date > latest ? r.date : latest), rows[0]!.date);
  return { periodDays, spend, asOf, hasData: true };
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
  const rows = await db
    .select({
      entityId: entityAnalyses.entityId,
      entityName: entityAnalyses.entityName,
      unitJson: entityAnalyses.unitJson,
      metricsJson: entityAnalyses.metricsJson,
      flags: entityAnalyses.flags,
      analyzedAt: entityAnalyses.analyzedAt,
    })
    .from(entityAnalyses)
    .where(and(eq(entityAnalyses.agentId, agentId), eq(entityAnalyses.entityLevel, CAMPAIGN_LEVEL)))
    .orderBy(desc(entityAnalyses.analyzedAt));

  const needle = name.trim().toLowerCase();
  const matches = rows.filter((r) => (r.entityName ?? "").toLowerCase().includes(needle));

  if (matches.length === 0) {
    return { hasData: false, note: `nenhuma campanha analisada com "${name}" no nome` };
  }
  if (matches.length > 1) {
    const names = matches.map((r) => r.entityName ?? "(sem nome)");
    return {
      hasData: false,
      ambiguous: true,
      matches: names,
      note: "mais de uma campanha casa esse nome — peça p/ especificar qual",
    };
  }

  const row = matches[0]!;
  const unit = row.unitJson as Partial<UnitAnalysis>;
  const m = row.metricsJson as Partial<InsightMetrics>;
  const top = unit.findings?.[0];
  return {
    id: row.entityId,
    name: row.entityName ?? null,
    ...(typeof m.spend === "number" ? { spend: m.spend } : {}),
    ...(typeof m.cpa === "number" ? { cpa: m.cpa } : {}),
    ...(typeof m.roas === "number" ? { roas: m.roas } : {}),
    summary: unit.summary ?? null,
    topFinding: top ? { title: top.title, severity: top.severity } : null,
    flags: row.flags ?? [],
    asOf: row.analyzedAt.toISOString(),
  };
}

/** Recomendações do último run finalizado do agente. Vazio → `hasData:false`. */
export async function listRecommendationsData(
  db: Database,
  agentId: string,
  orgId: string,
): Promise<RecommendationItem[] | NoData> {
  const run = await latestFinishedRun(db, agentId, orgId);
  if (!run) return { hasData: false, note: "sem análise concluída ainda" };

  const recs = await db
    .select({
      title: recommendations.title,
      rationale: recommendations.rationale,
      riskLevel: recommendations.riskLevel,
    })
    .from(recommendations)
    .where(and(eq(recommendations.runId, run.id), eq(recommendations.orgId, orgId)));

  if (recs.length === 0) return { hasData: false, note: "a última análise não gerou recomendações" };
  return recs.map((r) => ({ title: r.title, rationale: r.rationale ?? null, riskLevel: r.riskLevel }));
}

/** Aprovações pendentes da org (cross-conta por design). Vazio → `hasData:false`. */
export async function listPendingData(
  approvalPort: ApprovalPort,
  orgId: string,
): Promise<PendingItem[] | NoData> {
  const pending = await approvalPort.listPendingByOrg(orgId as OrgId);
  if (pending.length === 0) return { hasData: false, note: "nenhuma ação aguardando aprovação" };
  return pending.map((a) => ({
    id: a.id,
    entityLevel: a.entityLevel,
    entityId: a.entityId,
    entityName: a.action.target?.name ?? null,
    actionType: a.actionType,
    reason: a.action.reason,
    expiresAt: a.expiresAt.toISOString(),
  }));
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
  now: () => Date = () => new Date(),
): Promise<{ periodDays: number; current: number; previous: number; deltaPct: number | null; hasData: boolean }> {
  const curSince = formatDate(daysAgo(now(), periodDays));
  const prevSince = formatDate(daysAgo(now(), periodDays * 2));
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
  periodDays = ENTITY_TREND_DAYS,
): Promise<
  | { name: string | null; id: string; trend: { date: string; spend: number }[]; totalSpend: number; flags: readonly string[] }
  | NoData
  | AmbiguousCampaign
> {
  const analysis = await getCampaignAnalysisData(db, agentId, name);
  if ("hasData" in analysis) return analysis; // NoData | AmbiguousCampaign
  const since = formatDate(daysAgo(new Date(), periodDays));
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
  return { name: analysis.name, id: analysis.id, trend, totalSpend, flags: analysis.flags };
}

/** Config atual do agente (só leitura) — "como você tá configurado?". Mudar = pelo site. */
export async function getAgentConfigData(
  db: Database,
  orgId: string,
  agentId: string,
): Promise<{ goals: unknown; autonomy: unknown; guardrails: unknown; archetype: string } | NoData> {
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
  };
}

/** Explica uma recomendação da última análise (por trecho do título) — motivo + risco. */
export async function explainRecommendationData(
  db: Database,
  agentId: string,
  orgId: string,
  title: string,
): Promise<{ title: string; rationale: string | null; riskLevel: string } | NoData> {
  const run = await latestFinishedRun(db, agentId, orgId);
  if (!run) return { hasData: false, note: "sem análise concluída ainda" };
  const recs = await db
    .select({ title: recommendations.title, rationale: recommendations.rationale, riskLevel: recommendations.riskLevel })
    .from(recommendations)
    .where(and(eq(recommendations.runId, run.id), eq(recommendations.orgId, orgId)));
  const needle = title.trim().toLowerCase();
  const match = recs.find((r) => r.title.toLowerCase().includes(needle)) ?? (recs.length === 1 ? recs[0] : undefined);
  if (!match) return { hasData: false, note: `não achei uma recomendação com "${title}"` };
  return { title: match.title, rationale: match.rationale ?? null, riskLevel: match.riskLevel };
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

/** Data N dias atrás (inclusiva da janela), em UTC. */
function daysAgo(from: Date, days: number): Date {
  const d = new Date(from);
  d.setUTCDate(d.getUTCDate() - (days - 1));
  return d;
}

/** Date → "YYYY-MM-DD" (formato da coluna `insights_snapshots.date`). */
function formatDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

// ─── Montagem das tools (LangChain) ──────────────────────────────────────────

/** Serializa a saída curada p/ a string que o modelo lê. */
function asString(value: unknown): string {
  return JSON.stringify(value);
}

/**
 * Monta as 5 tools de LEITURA do turno (todas org-scoped, read-only sobre o nosso
 * DB curado). Seguro executar direto — não há escrita nem chamada à plataforma.
 */
export function makeReadTools(deps: WorkerDeps, ctx: ReadToolContext) {
  const { db, ports, logger } = deps;

  const getAccountStatus = tool(
    async () => {
      logger.debug({ agentId: ctx.agentId }, "tool:get_account_status");
      return asString(await getAccountStatusData(db, ctx.agentId, ctx.orgId, ports.approval));
    },
    {
      name: "get_account_status",
      description:
        "Status atual da conta pela última análise concluída: nota, resumo, gasto, DESPERDÍCIO (waste: quanto está queimando em campanhas paradas e onde o gasto está mal alocado — lidere por isso quando houver), nº de recomendações e de aprovações pendentes.",
      schema: z.object({}),
    },
  );

  const getMetrics = tool(
    async ({ periodDays }: { periodDays?: number | null }) => {
      const days = periodDays ?? DEFAULT_METRICS_PERIOD_DAYS;
      logger.debug({ adAccountId: ctx.adAccountId, periodDays: days }, "tool:get_metrics");
      return asString(await getMetricsData(db, ctx.adAccountId, ctx.orgId, days));
    },
    {
      name: "get_metrics",
      description: "Gasto total da conta nos últimos N dias (default 7). Só gasto — não deriva CPA/ROAS.",
      // nullable+optional: structured-output exige que campo omissível seja nullable.
      schema: z.object({ periodDays: z.number().int().positive().nullable().optional() }),
    },
  );

  const getFreshMetrics = tool(
    async ({ periodDays, campaign }: { periodDays?: number | null; campaign?: string | null }) => {
      logger.debug({ adAccountId: ctx.adAccountId, periodDays, campaign }, "tool:get_fresh_metrics");
      return asString(
        await getFreshMetricsData(
          { db, vault: ports.vault, insightsSync: deps.insightsSync, logger },
          { orgId: ctx.orgId, agentId: ctx.agentId, adAccountId: ctx.adAccountId },
          { periodDays: periodDays ?? null, campaign: campaign ?? null },
        ),
      );
    },
    {
      name: "get_fresh_metrics",
      description:
        "Puxa métricas ATUALIZADAS direto da Meta (gasto, resultados, CPA/ROAS, CPC/CPM) da conta nos últimos N dias (default hoje, máx 7 — hoje até 7 dias atrás). Se o usuário citar o nome de uma campanha, traz a dela em vez da conta. Use quando ele pedir 'como está HOJE / agora / atualizado / essa semana'. Se a Meta estiver indisponível/limitada, cai no último dado sincronizado e o campo updated vem false (avise que não atualizou agora); se não houver dado do período nem no salvo, o campo error explica — repasse ao usuário.",
      schema: z.object({
        periodDays: z.number().int().positive().nullable().optional(),
        campaign: z.string().nullable().optional(),
      }),
    },
  );

  const getCampaignAnalysis = tool(
    async ({ name }: { name: string }) => {
      logger.debug({ agentId: ctx.agentId, name }, "tool:get_campaign_analysis");
      return asString(await getCampaignAnalysisData(db, ctx.agentId, name));
    },
    {
      name: "get_campaign_analysis",
      description:
        "Última análise de uma campanha pelo nome (busca por trecho, sem diferenciar maiúsculas). Devolve o id (use-o para agir), resumo, métricas curadas e o maior gargalo.",
      schema: z.object({ name: z.string() }),
    },
  );

  const findRecentActions = tool(
    async ({ name }: { name?: string | null }) => {
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
      logger.debug({ agentId: ctx.agentId }, "tool:list_recommendations");
      return asString(await listRecommendationsData(db, ctx.agentId, ctx.orgId));
    },
    {
      name: "list_recommendations",
      description: "Recomendações da última análise concluída (título, motivo e nível de risco).",
      schema: z.object({}),
    },
  );

  const listPending = tool(
    async () => {
      logger.debug({ orgId: ctx.orgId }, "tool:list_pending");
      return asString(await listPendingData(ports.approval, ctx.orgId));
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
      const days = periodDays ?? DEFAULT_METRICS_PERIOD_DAYS;
      logger.debug({ adAccountId: ctx.adAccountId, periodDays: days }, "tool:compare_periods");
      return asString(await comparePeriodsData(db, ctx.adAccountId, ctx.orgId, days));
    },
    {
      name: "compare_periods",
      description: "Compara o gasto da conta em duas janelas contíguas (esta vs a anterior de N dias) + variação %.",
      schema: z.object({ periodDays: z.number().int().positive().nullable().optional() }),
    },
  );

  const getEntityDetail = tool(
    async ({ name }: { name: string }) => {
      logger.debug({ agentId: ctx.agentId, name }, "tool:get_entity_detail");
      return asString(await getEntityDetailData(db, ctx.agentId, ctx.adAccountId, ctx.orgId, name));
    },
    {
      name: "get_entity_detail",
      description: "Detalha uma campanha pelo nome: tendência diária de gasto + flags. Use para 'como o gasto da X evoluiu'.",
      schema: z.object({ name: z.string() }),
    },
  );

  const getAgentConfig = tool(
    async () => {
      logger.debug({ agentId: ctx.agentId }, "tool:get_agent_config");
      return asString(await getAgentConfigData(db, ctx.orgId, ctx.agentId));
    },
    {
      name: "get_agent_config",
      description: "Como o agente está configurado hoje (objetivo/meta, autonomia, guardrails). Só leitura — mudar é pelo site.",
      schema: z.object({}),
    },
  );

  const explainRecommendation = tool(
    async ({ title }: { title: string }) => {
      logger.debug({ agentId: ctx.agentId, title }, "tool:explain_recommendation");
      return asString(await explainRecommendationData(db, ctx.agentId, ctx.orgId, title));
    },
    {
      name: "explain_recommendation",
      description: "Explica uma recomendação da última análise (por trecho do título): motivo e nível de risco.",
      schema: z.object({ title: z.string() }),
    },
  );

  return [
    getAccountStatus,
    getMetrics,
    getFreshMetrics,
    getCampaignAnalysis,
    getEntityDetail,
    comparePeriods,
    findRecentActions,
    listRecommendations,
    listPending,
    listAccounts,
    getAgentConfig,
    explainRecommendation,
  ];
}
