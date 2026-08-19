// Agendamento por conta (3b): 1 Job Scheduler recorrente por agente ATIVO, com
// cadência (agents.cadence, fallback env) + jitter estável (stagger entre contas p/
// não bater o rate-limit da Meta juntas — §7). Idempotente via upsertSchedule (key
// estável). Ao disparar, cai na AGENT_CRON_QUEUE → o dispatcher cria o run.

import { eq } from "drizzle-orm";
import { agents } from "@trafego/db";
import { AGENT_CRON_QUEUE, type AgentCronDispatchPayload } from "@trafego/shared";
import type { SchedulerPort } from "@trafego/shared/ports";
import type { WorkerDeps } from "../composition.js";

export interface AccountSchedule {
  readonly orgId: string;
  readonly agentId: string;
  readonly adAccountId: string;
  /** cron da cadência do agente (5 campos). */
  readonly cron: string;
  readonly enabled: boolean;
}

/** Chave idempotente do scheduler por conta. */
export function scheduleKey(adAccountId: string): string {
  return `analysis:${adAccountId}`;
}

export function makeAccountCron(deps: WorkerDeps) {
  const scheduler: SchedulerPort = deps.ports.scheduler;
  const { logger } = deps;

  /** Upsert do scheduler recorrente de uma conta (cria ou atualiza cadência). */
  async function upsertAccountSchedule(s: AccountSchedule): Promise<void> {
    if (!s.enabled) {
      await scheduler.removeSchedule(scheduleKey(s.adAccountId));
      return;
    }
    logger.debug({ adAccountId: s.adAccountId, cron: s.cron }, "cron:upsert");
    const payload: AgentCronDispatchPayload = {
      orgId: s.orgId,
      agentId: s.agentId,
      adAccountId: s.adAccountId,
    };
    await scheduler.upsertSchedule({
      key: scheduleKey(s.adAccountId),
      queue: AGENT_CRON_QUEUE,
      cron: s.cron,
      tz: deps.cron.tz,
      jitterMs: deps.cron.jitterMs,
      payload,
    });
  }

  /** Remove o scheduler (agente pausado / conta desconectada). */
  async function removeAccountSchedule(adAccountId: string): Promise<void> {
    await scheduler.removeSchedule(scheduleKey(adAccountId));
  }

  /** Re-sincroniza os schedulers a partir dos agentes ATIVOS no boot. */
  async function syncAllFromDb(): Promise<void> {
    logger.info("cron:sync_all");
    const rows = await deps.db
      .select({
        orgId: agents.orgId,
        agentId: agents.id,
        adAccountId: agents.adAccountId,
        cadence: agents.cadence,
      })
      .from(agents)
      .where(eq(agents.status, "active"));
    for (const r of rows) {
      await upsertAccountSchedule({
        orgId: r.orgId,
        agentId: r.agentId,
        adAccountId: r.adAccountId,
        cron: r.cadence ?? deps.cron.defaultCron,
        enabled: true,
      });
    }
    logger.info({ count: rows.length }, "cron:sync_all done");
  }

  return { upsertAccountSchedule, removeAccountSchedule, syncAllFromDb };
}

export type AccountCron = ReturnType<typeof makeAccountCron>;
