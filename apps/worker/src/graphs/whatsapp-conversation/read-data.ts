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
import { adAccounts, adCreatives, agentRuns, agentToolCalls, agents, campaignDrafts, entityAnalyses, insightsSnapshots, recommendations } from "@trafego/db";
import type { Database } from "@trafego/db/client";
import { daysAgoInTz, rankAdCreatives, todayInTz, type RankableCreative } from "@trafego/core";
import { createAnalysisRepo, type AdCreativeCopyRow } from "../../modules/analysis/repo.js";
import { withTimeout } from "../../modules/conversation/with-timeout.js";
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
import { UNDO_BLOCKED_TOOL_KEY, UNDO_TOOL_KEY } from "@trafego/shared";
import type { AgentId, CampaignDraftSpec, CreativeAssetRef, DraftKind, EntityLevel, InsightMetrics, OrgId, TargetingSpec, UnitAnalysis } from "@trafego/shared";
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
  const kpis = aggregateKpis(rows.map((r) => r.metricsJson as StoredInsightMetrics), businessGoal);
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
      campaigns: Array<{
        id: string;
        name: string | null;
        spend: number | null;
        conversions: number | null;
        cpa: number | null;
        roas: number | null;
        revenue: number | null;
        tier: string | null;
      }>;
    }
  | NoData
> {
  const rows = await db
    .select({
      entityId: entityAnalyses.entityId,
      entityName: entityAnalyses.entityName,
      metricsJson: entityAnalyses.metricsJson,
      tier: entityAnalyses.tier,
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
    reason: a.action.reason,
    expiresAt: a.expiresAt.toISOString(),
  }));

  // draft (criar) + activation (ativar o já-criado) referenciam campaign_drafts → 1 query só.
  const draftRefs = [...drafts, ...activations];
  const byDraftId = new Map<string, { kind: DraftKind; spec: unknown }>();
  if (draftRefs.length > 0) {
    const rows = await db
      .select({ id: campaignDrafts.id, kind: campaignDrafts.kind, spec: campaignDrafts.spec })
      .from(campaignDrafts)
      .where(inArray(campaignDrafts.id, draftRefs.map((a) => a.draftId)));
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
  | { name: string | null; id: string; trend: { date: string; spend: number }[]; totalSpend: number; flags: readonly string[] }
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
    body: c.body ?? null,
    title: c.title ?? null,
    callToAction: c.callToAction ?? null,
    imageUrl: c.imageUrl ?? null,
    thumbnailUrl: c.thumbnailUrl ?? null,
    videoId: c.videoId ?? null,
  }));
  await repo.saveAdCreativeCopies(ctx.orgId, ctx.adAccountId, rows);
}

/**
 * Monta as 5 tools de LEITURA do turno (todas org-scoped, read-only sobre o nosso
 * DB curado). Seguro executar direto — não há escrita nem chamada à plataforma.
 */
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

  const getAccountStatus = tool(
    async () => {
      if (noFocus()) return NEEDS_FOCUS;
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
      if (noFocus()) return NEEDS_FOCUS;
      const days = periodDays ?? DEFAULT_METRICS_PERIOD_DAYS;
      logger.debug({ adAccountId: ctx.adAccountId, periodDays: days }, "tool:get_metrics");
      return asString(await getMetricsData(db, ctx.adAccountId, ctx.orgId, ctx.agentId, days, ctx.timezone));
    },
    {
      name: "get_metrics",
      description:
        "Gasto, conversões, CPA, ROAS e receita da conta (ou campanha, se ela for a única com dado) em QUALQUER período JÁ SINCRONIZADO — SEM limite de 7 dias (usa o último dado salvo, pode estar até 1 dia desatualizado; sem chamada nova à Meta). Use para períodos LONGOS (ex: 'últimos 10/30 dias', 'esse mês'). Pra dado mais atual e recente (hoje/ontem/últimos dias ≤7d), prefira get_fresh_metrics.",
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
      return asString(await getCampaignAnalysisData(db, ctx.agentId, name));
    },
    {
      name: "get_campaign_analysis",
      description:
        "Última análise de uma campanha pelo nome (busca por trecho, sem diferenciar maiúsculas). Devolve o id (use-o para agir), resumo, métricas curadas e o maior gargalo.",
      schema: z.object({ name: z.string() }),
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
      return asString(await listCampaignsData(db, ctx.agentId));
    },
    {
      name: "list_campaigns",
      description:
        "TODAS as campanhas da conta com métricas por campanha (gasto, conversões, CPA, ROAS, receita), ordenadas por gasto — pra COMPARAR/ALOCAR verba ('quais gastam mais e convertem pior', 'onde cortar/proteger', 'valores por campanha'). SEM args = última análise curada (inclui tier/diagnóstico). COM recorte de período (mesmo formato do get_fresh_metrics: periodDays, ou sinceDaysAgo+untilDaysAgo em dias atrás, 0=hoje/1=ontem, ≤7d) = dados FRESH agregados por campanha na janela. É a divisão por campanha que o get_fresh_metrics (agregado da conta) não dá.",
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
      description: "Detalha uma campanha pelo nome: tendência diária de gasto + flags. Use para 'como o gasto da X evoluiu'.",
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
      description: "Como o agente está configurado hoje (objetivo/meta, autonomia, guardrails). Só leitura — mudar é pelo site.",
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
      description: "Explica uma recomendação da última análise (por trecho do título): motivo e nível de risco.",
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
    getAccountStatus,
    getMetrics,
    getFreshMetrics,
    getCampaignAnalysis,
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
    getAdsBreakdown,
  ];
}
