// Dispatch do cron (3b): transforma um "tick" do scheduler em um run de análise.
// Cria a linha `agent_runs` (+guards) e enfileira o `execute`. Casca (IO) — a
// DECISÃO do cap é pura (@trafego/core). Idempotência do 1-run-por-conta é do
// índice único parcial em `agent_runs` (fecha o TOCTOU cron×manual — decisão 15).

import { and, eq } from "drizzle-orm";
import { adAccounts, agentRuns, agents, guardrailConfigs, isUniqueViolation, type Database } from "@trafego/db";
import { isOverCostCap, resolveCostCapUsd, usagePeriod } from "@trafego/core";
import {
  AGENT_RUNS_QUEUE,
  AGENT_RUN_JOB,
  type AgentRunExecutePayload,
} from "@trafego/shared";
import type { MeteringPort, SchedulerPort } from "@trafego/shared/ports";
import type { OrgId } from "@trafego/shared/types";
import type { Logger } from "pino";

export interface RunDispatcherDeps {
  readonly db: Database;
  readonly scheduler: SchedulerPort;
  readonly logger: Logger;
  /** ledger de custo (usage_events) — gasto do período (inclui visão). */
  readonly metering: MeteringPort;
  /** cap default global (env); o cap por-org vence quando definido. */
  readonly envCostCapUsd: number;
  /** relógio injetável (casca) — período p/ o gasto de custo. */
  readonly now?: () => Date;
}

export interface CronDispatchInput {
  readonly orgId: string;
  readonly agentId: string;
  readonly adAccountId: string;
}

export type DispatchOutcome =
  | "enqueued"
  | "skipped_paused"
  | "skipped_inactive_account"
  | "skipped_cost_cap"
  | "skipped_in_flight";

export function createRunDispatcher(deps: RunDispatcherDeps) {
  const clock = deps.now ?? (() => new Date());

  /** Gasto LLM da org no período (ledger de usage_events; inclui visão) — null se a leitura falhar. */
  async function spentThisPeriod(orgId: string): Promise<number | null> {
    try {
      return await deps.metering.llmCostInPeriod(orgId as OrgId, usagePeriod(clock()));
    } catch {
      return null; // ledger indisponível → fail-open (não trava o cron)
    }
  }

  /** Cap por-org (guardrail_configs) do agente, se houver. */
  async function orgCostCap(orgId: string, agentId: string): Promise<number | null> {
    const [row] = await deps.db
      .select({ cap: guardrailConfigs.llmCostCap })
      .from(guardrailConfigs)
      .where(and(eq(guardrailConfigs.agentId, agentId), eq(guardrailConfigs.orgId, orgId)))
      .limit(1);
    return row?.cap === null || row?.cap === undefined ? null : Number(row.cap);
  }

  async function dispatch(input: CronDispatchInput): Promise<DispatchOutcome> {
    const { orgId, agentId, adAccountId } = input;

    // 1) agente pausado (freio self-service — decisão 16) → pula silenciosamente.
    // Também pula se a conta não está sob gestão (unavailable/removed — soft).
    const [row] = await deps.db
      .select({ agentStatus: agents.status, accountStatus: adAccounts.status })
      .from(agents)
      .innerJoin(adAccounts, eq(agents.adAccountId, adAccounts.id))
      .where(and(eq(agents.id, agentId), eq(agents.orgId, orgId)))
      .limit(1);
    if (!row || row.agentStatus === "paused") return "skipped_paused";
    if (row.accountStatus !== "active") return "skipped_inactive_account";

    // 2) cap de custo por org/período (decisão pura; fail-open se custo ausente).
    const cap = resolveCostCapUsd(await orgCostCap(orgId, agentId), deps.envCostCapUsd);
    if (isOverCostCap(await spentThisPeriod(orgId), cap)) {
      deps.logger.warn({ orgId, agentId }, "cron:pula — cap de custo do período atingido");
      return "skipped_cost_cap";
    }

    // 3) cria o run — o índice único parcial garante 1 in-flight por agente.
    let runId: string;
    try {
      const [run] = await deps.db
        .insert(agentRuns)
        .values({ orgId, agentId, trigger: "cron", status: "pending" })
        .returning({ id: agentRuns.id });
      if (!run) return "skipped_in_flight";
      runId = run.id;
    } catch (error) {
      if (isUniqueViolation(error)) {
        deps.logger.debug({ orgId, agentId }, "cron:pula — já há run em andamento");
        return "skipped_in_flight";
      }
      throw error;
    }

    // 4) enfileira o execute (idempotente por runId).
    const payload: AgentRunExecutePayload = {
      mode: "execute",
      trigger: "cron",
      runId,
      orgId,
      agentId,
      adAccountId,
    };
    await deps.scheduler.enqueue({
      queue: AGENT_RUNS_QUEUE,
      name: AGENT_RUN_JOB,
      payload,
      idempotencyKey: runId,
    });
    return "enqueued";
  }

  return { dispatch };
}
