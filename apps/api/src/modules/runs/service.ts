import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import { agentRuns, agents, recommendations, type Database } from "@trafego/db";
import { READ_ONLY_APPLICABILITY } from "@trafego/core";
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

    await assertUnderCostCap(orgId);
    await assertNoRunInFlight(orgId, agentId);

    const [run] = await deps.db
      .insert(agentRuns)
      .values({ orgId, agentId, trigger: "on_demand", status: "pending" })
      .returning({ id: agentRuns.id });
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

  /** Bloqueia se o custo LLM do período (mês corrente) já atingiu o cap. */
  async function assertUnderCostCap(orgId: OrgId): Promise<void> {
    if (deps.costCapUsd <= 0) return; // sem cap
    const now = new Date();
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const [row] = await deps.db
      .select({ total: sql<string>`coalesce(sum(${agentRuns.costSnapshot}), 0)` })
      .from(agentRuns)
      .where(and(eq(agentRuns.orgId, orgId), gte(agentRuns.createdAt, monthStart)));
    const spent = Number(row?.total ?? 0);
    if (spent >= deps.costCapUsd) {
      throw badRequest(
        "Você atingiu o limite de custo de análise deste período. Ele renova no próximo mês.",
      );
    }
  }

  /**
   * Impede runs simultâneos na mesma conta (custo Meta/LLM + confusão).
   * NOTA: check-then-insert sem transação → há janela TOCTOU (2 POSTs concorrentes
   * podem ambos passar). Aceitável na 3a (on-demand; o front também desabilita o
   * botão). Fatia 5a fecha a janela com índice único parcial em
   * `agent_runs(agent_id) WHERE status IN (in-flight)` ou advisory lock.
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
