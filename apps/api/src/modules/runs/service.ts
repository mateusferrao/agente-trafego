import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import { agentRuns, agents, guardrailConfigs, recommendations, type Database } from "@trafego/db";
import { isOverCostCap, READ_ONLY_APPLICABILITY, resolveCostCapUsd } from "@trafego/core";
import {
  AGENT_RUNS_QUEUE,
  AGENT_RUN_JOB,
  type AgentRunExecutePayload,
} from "@trafego/shared";
import type { Action, OrgId, RunId } from "@trafego/shared/types";
import type { SchedulerPort } from "@trafego/shared/ports";
import { badRequest, conflict } from "../../middleware/error-handler.js";
import {
  runMetrics,
  type LatestRunOutput,
  type RecommendationOutput,
  type RunOutput,
  type RunSummary,
  type RunTimeline,
  type TriggerRunOutput,
} from "./schema.js";

/** Garante o agente da conta (injetado do slice de agentes — evita duplicar lógica). */
export type EnsureAgent = (orgId: OrgId, accountId: string) => Promise<{ agentId: string }>;

export interface RunsDeps {
  readonly db: Database;
  readonly scheduler: SchedulerPort;
  readonly ensureAgent: EnsureAgent;
  /** cap de custo LLM por org/período (0 = sem cap) — checado pré-run. */
  readonly costCapUsd: number;
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

    const recs = await deps.db
      .select()
      .from(recommendations)
      .where(and(eq(recommendations.runId, run.id), eq(recommendations.orgId, orgId)));

    return { run: toRunOutput(run), recommendations: recs.map(toRecommendationOutput) };
  }

  /**
   * Bloqueia se o custo LLM do período (mês corrente) já atingiu o cap. O cap é
   * por-org (`guardrail_configs.llm_cost_cap`, fallback env); decisão pura no core.
   */
  async function assertUnderCostCap(orgId: OrgId, agentId: string): Promise<void> {
    const [guard] = await deps.db
      .select({ cap: guardrailConfigs.llmCostCap })
      .from(guardrailConfigs)
      .where(and(eq(guardrailConfigs.agentId, agentId), eq(guardrailConfigs.orgId, orgId)))
      .limit(1);
    const cap = resolveCostCapUsd(guard?.cap === null || guard?.cap === undefined ? null : Number(guard.cap), deps.costCapUsd);
    if (cap <= 0) return;

    const now = new Date();
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const [row] = await deps.db
      .select({ total: sql<string | null>`sum(${agentRuns.costSnapshot})` })
      .from(agentRuns)
      .where(and(eq(agentRuns.orgId, orgId), gte(agentRuns.createdAt, monthStart)));
    const spent = row?.total === null || row?.total === undefined ? null : Number(row.total);
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

  // ── leitura de histórico (6a — mantido stub por ora) ───────────────────
  async function list(_orgId: OrgId): Promise<RunSummary[]> {
    return [];
  }
  async function timeline(_orgId: OrgId, _runId: RunId): Promise<RunTimeline> {
    throw badRequest("Timeline ainda não disponível.");
  }

  return { trigger, latest, list, timeline };
}

/** Detecta violação de unique constraint do Postgres (código 23505). */
function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "23505"
  );
}

type AgentRunRow = typeof agentRuns.$inferSelect;
type RecommendationRow = typeof recommendations.$inferSelect;

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

function toRecommendationOutput(rec: RecommendationRow): RecommendationOutput {
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
  };
}
