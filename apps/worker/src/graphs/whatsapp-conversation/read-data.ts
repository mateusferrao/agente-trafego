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

import { and, desc, eq, gte, inArray } from "drizzle-orm";
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { agentRuns, entityAnalyses, insightsSnapshots, recommendations } from "@trafego/db";
import type { Database } from "@trafego/db/client";
import type { ApprovalPort } from "@trafego/shared/ports";
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

// ─── Formas de saída (curadas p/ o modelo) ──────────────────────────────────
interface NoData {
  readonly hasData: false;
  readonly note: string;
}

interface AccountStatus {
  readonly grade: string | null;
  readonly headline: string | null;
  readonly summary: string | null;
  readonly spend?: number;
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
  readonly entityLevel: string;
  readonly entityId: string;
  readonly actionType: string;
  readonly reason: string;
  readonly expiresAt: string;
}

/** Snapshot de métricas do run (jsonb livre) — lido defensivamente. */
interface RunMetricsSnapshot {
  readonly kpis?: { readonly spend?: number };
  readonly scorecard?: { readonly grade?: string; readonly headline?: string };
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
  return {
    grade: snap?.scorecard?.grade ?? null,
    headline: snap?.scorecard?.headline ?? null,
    summary: run.summary ?? null,
    ...(typeof spend === "number" ? { spend } : {}),
    recommendationCount: recIds.length,
    pendingCount: pending.length,
    asOf: (run.finishedAt ?? run.createdAt).toISOString(),
  };
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
    entityLevel: a.entityLevel,
    entityId: a.entityId,
    actionType: a.actionType,
    reason: a.action.reason,
    expiresAt: a.expiresAt.toISOString(),
  }));
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
        "Status atual da conta pela última análise concluída: nota, resumo, gasto, nº de recomendações e de aprovações pendentes.",
      schema: z.object({}),
    },
  );

  const getMetrics = tool(
    async ({ periodDays }: { periodDays: number }) => {
      logger.debug({ adAccountId: ctx.adAccountId, periodDays }, "tool:get_metrics");
      return asString(await getMetricsData(db, ctx.adAccountId, ctx.orgId, periodDays));
    },
    {
      name: "get_metrics",
      description: "Gasto total da conta nos últimos N dias (default 7). Só gasto — não deriva CPA/ROAS.",
      schema: z.object({ periodDays: z.number().int().positive().default(DEFAULT_METRICS_PERIOD_DAYS) }),
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
        "Última análise de uma campanha pelo nome (busca por trecho, sem diferenciar maiúsculas). Devolve resumo, métricas curadas e o maior gargalo.",
      schema: z.object({ name: z.string() }),
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

  return [getAccountStatus, getMetrics, getCampaignAnalysis, listRecommendations, listPending];
}
