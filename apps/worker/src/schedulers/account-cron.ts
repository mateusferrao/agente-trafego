// Agendamento por conta: um job scheduler recorrente por ad_account, com
// cadência configurável (agents.cadence) e JITTER p/ espalhar carga entre contas
// (evita pico simultâneo no rate-limit da Meta — CLAUDE §7). Idempotente via
// SchedulerPort.upsertSchedule (key estável).

import type { SchedulerPort } from "@trafego/shared/ports";
import { AGENT_RUNS_QUEUE } from "@trafego/shared";
import type { WorkerDeps } from "../composition.js";

export interface AccountSchedule {
  readonly orgId: string;
  readonly agentId: string;
  readonly adAccountId: string;
  /** cron da cadência do agente (ex: `0 0/6 * * *` = de 6 em 6 horas). */
  readonly cron: string;
  readonly enabled: boolean;
}

/** jitter máximo p/ stagger entre contas (ms). */
const MAX_JITTER_MS = 5 * 60 * 1000;

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
    // TODO(3b): este payload NÃO é o `AgentRunExecutePayload` — falta `mode:"execute"`
    // e `runId`. O caminho cron não pode carregar um runId fixo num schedule recorrente:
    // ao disparar, precisa CRIAR o run (linha em agent_runs) e só então executar. Enquanto
    // não for ligado (main.ts não sincroniza schedulers na 3a), o worker trataria este job
    // como resume não suportado e faria no-op. Fatia 3b desenha o dispatch (cria run→execute).
    await scheduler.upsertSchedule({
      key: scheduleKey(s.adAccountId),
      cron: s.cron,
      jitterMs: MAX_JITTER_MS,
      payload: {
        queue: AGENT_RUNS_QUEUE,
        trigger: "cron",
        orgId: s.orgId,
        agentId: s.agentId,
        adAccountId: s.adAccountId,
      },
    });
  }

  /** Remove o scheduler (agente desativado / conta desconectada). */
  async function removeAccountSchedule(adAccountId: string): Promise<void> {
    await scheduler.removeSchedule(scheduleKey(adAccountId));
  }

  /** Re-sincroniza todos os schedulers a partir dos agentes ativos no boot. */
  async function syncAllFromDb(): Promise<void> {
    logger.info("cron:sync_all");
    // TODO: buscar agentes ativos (db) → upsertAccountSchedule p/ cada um.
  }

  return { upsertAccountSchedule, removeAccountSchedule, syncAllFromDb };
}

export type AccountCron = ReturnType<typeof makeAccountCron>;
