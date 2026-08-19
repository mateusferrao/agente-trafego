import { and, desc, eq, gte, inArray, lte, sql } from "drizzle-orm";
import {
  agentMutedEntities,
  agentRuns,
  agents,
  entityAnalyses,
  guardrailConfigs,
  isUniqueViolation,
  recommendationFeedback,
  recommendations,
  type Database,
} from "@trafego/db";
import type { InsightMetrics, UnitAnalysis } from "@trafego/shared";
import { isOverCostCap, READ_ONLY_APPLICABILITY, resolveCostCapUsd, usagePeriod } from "@trafego/core";
import {
  AGENT_RUNS_QUEUE,
  AGENT_RUN_JOB,
  type AgentRunExecutePayload,
} from "@trafego/shared";
import type { Action, OrgId, RunCampaignCard } from "@trafego/shared/types";
import type { MeteringPort, SchedulerPort } from "@trafego/shared/ports";
import { badRequest, conflict, notFound } from "../../middleware/error-handler.js";
import {
  runMetrics,
  type CampaignAnalysisOutput,
  type LatestRunOutput,
  type RecommendationOutput,
  type RunDetailOutput,
  type RunListItem,
  type RunListOutput,
  type RunOutput,
  type TriggerRunOutput,
} from "./schema.js";

/** Filtros + paginação da lista de análises anteriores (6a). */
export interface ListRunsOptions {
  readonly grades?: readonly string[];
  readonly since?: string; // ISO
  readonly until?: string; // ISO
  readonly limit?: number;
  readonly offset?: number;
}

const RUNS_PAGE_DEFAULT = 20;
const RUNS_PAGE_MAX = 50;
/** Runs finalizados que entram no histórico (exclui in-flight). */
const FINISHED_STATUSES = ["succeeded", "failed"] as const;

/** Garante o agente da conta (injetado do slice de agentes — evita duplicar lógica). */
export type EnsureAgent = (orgId: OrgId, accountId: string) => Promise<{ agentId: string }>;

export interface RunsDeps {
  readonly db: Database;
  readonly scheduler: SchedulerPort;
  readonly ensureAgent: EnsureAgent;
  /** ledger de custo (usage_events) — fonte do gasto do período (inclui visão). */
  readonly metering: MeteringPort;
  /** cap de custo LLM por org/período (0 = sem cap) — checado pré-run. */
  readonly costCapUsd: number;
  /** relógio injetável (casca) — período do cap. */
  readonly now?: () => Date;
}

const IN_FLIGHT_STATUSES = ["pending", "running", "waiting_approval"] as const;

/**
 * Slice de runs. 3a: dispara a análise on-demand (com cap por período +
 * 1-run-por-conta) e lê o último run + recomendações. Histórico/timeline = 6a.
 */
export function createRunsService(deps: RunsDeps) {
  /** Dispara um run de análise para a conta (autenticado, org-scoped). */
  async function trigger(orgId: OrgId, accountId: string): Promise<TriggerRunOutput> {
    const { agentId } = await deps.ensureAgent(orgId, accountId);

    await assertUnderCostCap(orgId, agentId);
    await assertNoRunInFlight(orgId, agentId);

    let run: { id: string } | undefined;
    try {
      [run] = await deps.db
        .insert(agentRuns)
        .values({ orgId, agentId, trigger: "on_demand", status: "pending" })
        .returning({ id: agentRuns.id });
    } catch (error) {
      // corrida com o cron ou outra aba: o índice único parcial (in-flight por
      // agente) rejeita o 2º run → conflito amigável (fecha o TOCTOU — decisão 15).
      if (isUniqueViolation(error)) {
        throw conflict("Já existe uma análise em andamento para esta conta. Aguarde ela terminar.");
      }
      throw error;
    }
    if (!run) throw badRequest("Não consegui iniciar a análise. Tente de novo.");

    const payload: AgentRunExecutePayload = {
      mode: "execute",
      trigger: "on_demand",
      runId: run.id,
      orgId,
      agentId,
      adAccountId: accountId,
    };
    await deps.scheduler.enqueue({ queue: AGENT_RUNS_QUEUE, name: AGENT_RUN_JOB, payload });
    return { runId: run.id, status: "pending" };
  }

  /** Último run da conta + recomendações (o site mostra o resultado). */
  async function latest(orgId: OrgId, accountId: string): Promise<LatestRunOutput> {
    const [agent] = await deps.db
      .select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.adAccountId, accountId), eq(agents.orgId, orgId)))
      .limit(1);
    if (!agent) return { run: null, recommendations: [] };

    const [run] = await deps.db
      .select()
      .from(agentRuns)
      .where(and(eq(agentRuns.agentId, agent.id), eq(agentRuns.orgId, orgId)))
      .orderBy(desc(agentRuns.createdAt))
      .limit(1);
    if (!run) return { run: null, recommendations: [] };

    return {
      run: toRunOutput(run),
      recommendations: await recommendationsForRun(orgId, run.id),
    };
  }

  /** Recomendações de um run + o voto (👍/👎) mais recente de cada — reuso latest/detalhe. */
  async function recommendationsForRun(orgId: OrgId, runId: string): Promise<RecommendationOutput[]> {
    const recs = await deps.db
      .select()
      .from(recommendations)
      .where(and(eq(recommendations.runId, runId), eq(recommendations.orgId, orgId)));
    const recIds = recs.map((r) => r.id);
    const votes = new Map<string, "up" | "down">();
    if (recIds.length > 0) {
      const rows = await deps.db
        .select({ recommendationId: recommendationFeedback.recommendationId, vote: recommendationFeedback.vote })
        .from(recommendationFeedback)
        .where(inArray(recommendationFeedback.recommendationId, recIds))
        .orderBy(desc(recommendationFeedback.createdAt));
      for (const row of rows) {
        if (row.vote && !votes.has(row.recommendationId)) votes.set(row.recommendationId, row.vote);
      }
    }
    return recs.map((r) => toRecommendationOutput(r, votes.get(r.id) ?? null));
  }

  /**
   * Bloqueia se o custo LLM do período (mês corrente) já atingiu o cap. O cap é
   * por-org (`guardrail_configs.llm_cost_cap`, fallback env); decisão pura no core.
   * O gasto vem do ledger de metering (`usage_events`) — inclui TODA chamada
   * (unit/vision/synthesis/review/message), não só o snapshot do run. Falha na
   * leitura do ledger = fail-open (não trava a análise — "custo ausente ≠ zero").
   */
  async function assertUnderCostCap(orgId: OrgId, agentId: string): Promise<void> {
    const [guard] = await deps.db
      .select({ cap: guardrailConfigs.llmCostCap })
      .from(guardrailConfigs)
      .where(and(eq(guardrailConfigs.agentId, agentId), eq(guardrailConfigs.orgId, orgId)))
      .limit(1);
    const cap = resolveCostCapUsd(guard?.cap === null || guard?.cap === undefined ? null : Number(guard.cap), deps.costCapUsd);
    if (cap <= 0) return;

    let spent: number | null;
    try {
      spent = await deps.metering.llmCostInPeriod(orgId, usagePeriod((deps.now ?? (() => new Date()))()));
    } catch {
      return; // ledger indisponível → fail-open (não bloqueia a análise)
    }
    if (isOverCostCap(spent, cap)) {
      throw badRequest(
        "Você atingiu o limite de custo de análise deste período. Ele renova no próximo mês.",
      );
    }
  }

  /**
   * Impede runs simultâneos na mesma conta (pré-check amigável). A garantia real é
   * o índice único parcial em `agent_runs` (in-flight por agente) — o insert do
   * trigger captura a violação e vira conflito (fecha o TOCTOU cron×manual).
   */
  async function assertNoRunInFlight(orgId: OrgId, agentId: string): Promise<void> {
    const [running] = await deps.db
      .select({ id: agentRuns.id })
      .from(agentRuns)
      .where(
        and(
          eq(agentRuns.agentId, agentId),
          eq(agentRuns.orgId, orgId),
          inArray(agentRuns.status, [...IN_FLIGHT_STATUSES]),
        ),
      )
      .limit(1);
    if (running) {
      throw conflict("Já existe uma análise em andamento para esta conta. Aguarde ela terminar.");
    }
  }

  /**
   * Recorte por campanha: a ÚLTIMA análise conhecida de cada campanha (nível
   * `campaign` em `entity_analyses`, 1 linha por campanha, upsertada), com métrica
   * curada + resumo + maior gargalo + flags + estado silenciado. Campanhas herdadas
   * (incremental) mantêm sua última análise — por isso "última conhecida", não "só
   * as do run mais recente". Base dos cartões por campanha no site.
   */
  async function campaignAnalyses(orgId: OrgId, accountId: string): Promise<CampaignAnalysisOutput[]> {
    const [agent] = await deps.db
      .select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.adAccountId, accountId), eq(agents.orgId, orgId)))
      .limit(1);
    if (!agent) return [];

    const rows = await deps.db
      .select({
        entityId: entityAnalyses.entityId,
        name: entityAnalyses.entityName,
        unitJson: entityAnalyses.unitJson,
        metricsJson: entityAnalyses.metricsJson,
        flags: entityAnalyses.flags,
        analyzedAt: entityAnalyses.analyzedAt,
      })
      .from(entityAnalyses)
      .where(and(eq(entityAnalyses.agentId, agent.id), eq(entityAnalyses.entityLevel, "campaign")))
      .orderBy(desc(entityAnalyses.analyzedAt));

    const mutedRows = await deps.db
      .select({ externalId: agentMutedEntities.externalId })
      .from(agentMutedEntities)
      .where(
        and(
          eq(agentMutedEntities.agentId, agent.id),
          eq(agentMutedEntities.orgId, orgId),
          eq(agentMutedEntities.entityLevel, "campaign"),
        ),
      );
    const muted = new Set(mutedRows.map((m) => m.externalId));

    return rows.map((r) => toCampaignAnalysisOutput(r, muted.has(r.entityId)));
  }

  /**
   * Histórico de análises da conta (6a): runs finalizados, mais recentes primeiro,
   * com filtros por nota + período e paginação. Org-scoped. `grade`/`headline` saem
   * do `metrics_snapshot.scorecard`.
   */
  async function listRuns(
    orgId: OrgId,
    accountId: string,
    opts: ListRunsOptions,
  ): Promise<RunListOutput> {
    const [agent] = await deps.db
      .select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.adAccountId, accountId), eq(agents.orgId, orgId)))
      .limit(1);
    if (!agent) return { items: [], hasMore: false };

    const limit = Math.min(RUNS_PAGE_MAX, Math.max(1, opts.limit ?? RUNS_PAGE_DEFAULT));
    const offset = Math.max(0, opts.offset ?? 0);
    const conds = [
      eq(agentRuns.agentId, agent.id),
      eq(agentRuns.orgId, orgId),
      inArray(agentRuns.status, [...FINISHED_STATUSES]),
    ];
    if (opts.grades && opts.grades.length > 0) {
      conds.push(inArray(sql`(${agentRuns.metricsSnapshot} #>> '{scorecard,grade}')`, [...opts.grades]));
    }
    if (opts.since) conds.push(gte(agentRuns.createdAt, new Date(opts.since)));
    if (opts.until) conds.push(lte(agentRuns.createdAt, new Date(opts.until)));

    const rows = await deps.db
      .select({
        id: agentRuns.id,
        createdAt: agentRuns.createdAt,
        trigger: agentRuns.trigger,
        status: agentRuns.status,
        partial: agentRuns.partial,
        costSnapshot: agentRuns.costSnapshot,
        metricsSnapshot: agentRuns.metricsSnapshot,
        summary: agentRuns.summary,
      })
      .from(agentRuns)
      .where(and(...conds))
      .orderBy(desc(agentRuns.createdAt))
      .limit(limit + 1)
      .offset(offset);

    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit);
    const counts = new Map<string, number>();
    const ids = page.map((r) => r.id);
    if (ids.length > 0) {
      const cr = await deps.db
        .select({ runId: recommendations.runId, n: sql<number>`count(*)::int` })
        .from(recommendations)
        .where(and(eq(recommendations.orgId, orgId), inArray(recommendations.runId, ids)))
        .groupBy(recommendations.runId);
      for (const c of cr) counts.set(c.runId, c.n);
    }
    return { items: page.map((r) => toRunListItem(r, counts.get(r.id) ?? 0)), hasMore };
  }

  /**
   * Detalhe de UM run (histórico): run + recomendações + recorte por campanha
   * CONGELADO no snapshot do run (`metrics_snapshot.campaigns`) + estado silenciado
   * atual. `isLatest` avisa o site quando não é a análise mais recente. Org-scoped.
   */
  async function runDetail(orgId: OrgId, accountId: string, runId: string): Promise<RunDetailOutput> {
    const [agent] = await deps.db
      .select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.adAccountId, accountId), eq(agents.orgId, orgId)))
      .limit(1);
    if (!agent) throw notFound("Conta não encontrada.");

    const [run] = await deps.db
      .select()
      .from(agentRuns)
      .where(and(eq(agentRuns.id, runId), eq(agentRuns.agentId, agent.id), eq(agentRuns.orgId, orgId)))
      .limit(1);
    if (!run) throw notFound("Análise não encontrada.");

    const recs = await recommendationsForRun(orgId, runId);
    const mutedRows = await deps.db
      .select({ externalId: agentMutedEntities.externalId })
      .from(agentMutedEntities)
      .where(
        and(
          eq(agentMutedEntities.agentId, agent.id),
          eq(agentMutedEntities.orgId, orgId),
          eq(agentMutedEntities.entityLevel, "campaign"),
        ),
      );
    const muted = new Set(mutedRows.map((m) => m.externalId));
    const campaigns = extractCampaignCards(run.metricsSnapshot).map((c) => ({
      externalId: c.externalId,
      name: c.name,
      metrics: c.metrics,
      summary: c.summary,
      topFinding: c.topFinding,
      flags: [...c.flags],
      muted: muted.has(c.externalId),
    }));

    // "mais recente" = último run FINALIZADO (ignora in-flight; casa com o que o
    // usuário considera a última análise concluída).
    const [latestRow] = await deps.db
      .select({ id: agentRuns.id })
      .from(agentRuns)
      .where(
        and(
          eq(agentRuns.agentId, agent.id),
          eq(agentRuns.orgId, orgId),
          inArray(agentRuns.status, [...FINISHED_STATUSES]),
        ),
      )
      .orderBy(desc(agentRuns.createdAt))
      .limit(1);

    return { run: toRunOutput(run), recommendations: recs, campaigns, isLatest: latestRow?.id === runId };
  }

  return { trigger, latest, campaignAnalyses, listRuns, runDetail };
}

/** Linha de `entity_analyses` (campanha) → output do cartão (métrica + gargalo curados). */
function toCampaignAnalysisOutput(
  row: {
    entityId: string;
    name: string | null;
    unitJson: Record<string, unknown>;
    metricsJson: Record<string, unknown>;
    flags: string[];
  },
  muted: boolean,
): CampaignAnalysisOutput {
  const unit = row.unitJson as unknown as Partial<UnitAnalysis>;
  const m = row.metricsJson as Partial<InsightMetrics>;
  const top = unit.findings?.[0];
  return {
    externalId: row.entityId,
    name: row.name ?? null,
    metrics: {
      spend: typeof m.spend === "number" ? m.spend : 0,
      ...(typeof m.ctr === "number" ? { ctr: m.ctr } : {}),
      ...(typeof m.cpa === "number" ? { cpa: m.cpa } : {}),
      ...(typeof m.roas === "number" ? { roas: m.roas } : {}),
    },
    summary: unit.summary ?? null,
    topFinding: top ? { title: top.title, severity: top.severity } : null,
    flags: row.flags ?? [],
    muted,
  };
}

type AgentRunRow = typeof agentRuns.$inferSelect;
type RecommendationRow = typeof recommendations.$inferSelect;

/** Linha de `agent_runs` → item da lista de histórico (nota/headline do scorecard). */
function toRunListItem(
  run: {
    id: string;
    createdAt: Date;
    trigger: AgentRunRow["trigger"];
    status: AgentRunRow["status"];
    partial: boolean;
    costSnapshot: string | null;
    metricsSnapshot: Record<string, unknown> | null;
    summary: string | null;
  },
  recommendationCount: number,
): RunListItem {
  const parsed = runMetrics.safeParse(run.metricsSnapshot);
  const scorecard = parsed.success ? parsed.data.scorecard : undefined;
  return {
    id: run.id,
    createdAt: run.createdAt.toISOString(),
    trigger: run.trigger,
    status: run.status,
    partial: run.partial,
    grade: scorecard?.grade ?? null,
    headline: scorecard?.headline ?? run.summary ?? null,
    recommendationCount,
    costUsd: run.costSnapshot === null ? null : Number(run.costSnapshot),
  };
}

/** Cartões por-campanha do snapshot do run (defensivo: array ou vazio). */
function extractCampaignCards(metricsSnapshot: Record<string, unknown> | null): RunCampaignCard[] {
  const c = metricsSnapshot?.campaigns;
  return Array.isArray(c) ? (c as RunCampaignCard[]) : [];
}

function toRunOutput(run: AgentRunRow): RunOutput {
  // metrics_snapshot é jsonb livre → valida contra o contrato (descarta se fora do shape).
  const parsedMetrics = runMetrics.safeParse(run.metricsSnapshot);
  return {
    id: run.id,
    status: run.status,
    summary: run.summary ?? null,
    partial: run.partial,
    costUsd: run.costSnapshot === null ? null : Number(run.costSnapshot),
    startedAt: run.startedAt ? run.startedAt.toISOString() : null,
    finishedAt: run.finishedAt ? run.finishedAt.toISOString() : null,
    metrics: parsedMetrics.success ? parsedMetrics.data : null,
  };
}

function toRecommendationOutput(rec: RecommendationRow, vote: "up" | "down" | null): RecommendationOutput {
  const action = rec.proposedAction as Action | null;
  return {
    id: rec.id,
    title: rec.title,
    rationale: rec.rationale ?? null,
    riskLevel: rec.riskLevel,
    applicability: READ_ONLY_APPLICABILITY,
    proposedAction: action
      ? { type: action.type, target: { level: action.target.level, id: action.target.id }, params: action.params }
      : null,
    vote,
  };
}
