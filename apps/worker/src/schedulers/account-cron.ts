// Agendamento por conta (3b): 1 Job Scheduler recorrente por agente ATIVO, com
// cadência (agents.cadence, fallback env) + jitter estável (stagger entre contas p/
// não bater o rate-limit da Meta juntas — §7). Idempotente via upsertSchedule (key
// estável). Ao disparar, cai na AGENT_CRON_QUEUE → o dispatcher cria o run.

import { and, eq } from "drizzle-orm";
import { adAccounts, agents, orgs } from "@trafego/db";
import { cadenceToCron } from "@trafego/core";
import {
  AGENT_CRON_QUEUE,
  AGENT_REAPER_QUEUE,
  AGENT_REAPER_SCHEDULE_KEY,
  APPROVAL_EXPIRY_QUEUE,
  APPROVAL_EXPIRY_SCHEDULE_KEY,
  INSIGHTS_SWEEP_QUEUE,
  INSIGHTS_SWEEP_SCHEDULE_KEY,
  type AgentCronDispatchPayload,
  type CadenceSpec,
} from "@trafego/shared";
import type { SchedulerPort } from "@trafego/shared/ports";
import type { WorkerDeps } from "../composition.js";

export interface AccountSchedule {
  readonly orgId: string;
  readonly agentId: string;
  readonly adAccountId: string;
  /** cron da cadência do agente (5 campos), já derivado do `CadenceSpec`. */
  readonly cron: string;
  /** fuso da org p/ avaliar o cron (fallback = tz global do env). */
  readonly tz?: string;
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
      tz: s.tz ?? deps.cron.tz,
      jitterMs: deps.cron.jitterMs,
      payload,
    });
  }

  /** Remove o scheduler (agente pausado / conta desconectada). */
  async function removeAccountSchedule(adAccountId: string): Promise<void> {
    await scheduler.removeSchedule(scheduleKey(adAccountId));
  }

  /** Garante o scheduler recorrente do reaper (singleton, key fixa — idempotente). */
  async function ensureReaperSchedule(): Promise<void> {
    await scheduler.upsertSchedule({
      key: AGENT_REAPER_SCHEDULE_KEY,
      queue: AGENT_REAPER_QUEUE,
      cron: deps.reaper.cron,
      tz: deps.cron.tz,
      payload: {},
    });
  }

  /**
   * Garante o sweep de frescura (singleton — 6a): tick recorrente a cada
   * `INSIGHTS_FRESH_THRESHOLD_MIN` que varre contas ativas e enfileira sync-only só
   * p/ as velhas. Intervalo = o mesmo threshold (staleness-gate dedupe o resto).
   */
  async function ensureInsightsSweepSchedule(): Promise<void> {
    await scheduler.upsertSchedule({
      key: INSIGHTS_SWEEP_SCHEDULE_KEY,
      queue: INSIGHTS_SWEEP_QUEUE,
      everyMs: deps.insights.freshThresholdMin * 60_000,
      payload: {},
    });
  }

  /** Garante o scheduler recorrente da expiração de aprovações (singleton — 5b). */
  async function ensureApprovalExpirySchedule(): Promise<void> {
    await scheduler.upsertSchedule({
      key: APPROVAL_EXPIRY_SCHEDULE_KEY,
      queue: APPROVAL_EXPIRY_QUEUE,
      cron: deps.approvalExpiryCron,
      tz: deps.cron.tz,
      payload: {},
    });
  }

  /** cron derivado do `CadenceSpec` (fonte única) ou o default global (env). */
  function cronFor(cadence: CadenceSpec | null): string {
    return cadence ? cadenceToCron(cadence) : deps.cron.defaultCron;
  }

  /** Re-sincroniza os schedulers a partir dos agentes ATIVOS no boot. */
  async function syncAllFromDb(): Promise<void> {
    logger.info("cron:sync_all");
    // só agenda agentes ativos de contas sob gestão (status `active` — conta
    // unavailable/removed não deve rodar cron, mesmo com agente ativo).
    const rows = await deps.db
      .select({
        orgId: agents.orgId,
        agentId: agents.id,
        adAccountId: agents.adAccountId,
        cadence: agents.cadence,
        tz: orgs.timezone,
      })
      .from(agents)
      .innerJoin(adAccounts, eq(agents.adAccountId, adAccounts.id))
      .innerJoin(orgs, eq(agents.orgId, orgs.id))
      .where(and(eq(agents.status, "active"), eq(adAccounts.status, "active")));
    for (const r of rows) {
      await upsertAccountSchedule({
        orgId: r.orgId,
        agentId: r.agentId,
        adAccountId: r.adAccountId,
        cron: cronFor(r.cadence),
        tz: r.tz,
        enabled: true,
      });
    }
    logger.info({ count: rows.length }, "cron:sync_all done");
  }

  /**
   * Re-sincroniza o schedule de UMA conta (Fatia 4): a API enfileira ao salvar a
   * cadência; o worker recarrega spec+fuso e faz upsert (ativo) ou remove. Dono
   * único do scheduler = worker.
   */
  async function resyncAccountSchedule(orgId: string, adAccountId: string): Promise<void> {
    const [r] = await deps.db
      .select({
        agentId: agents.id,
        cadence: agents.cadence,
        agentStatus: agents.status,
        accountStatus: adAccounts.status,
        tz: orgs.timezone,
      })
      .from(agents)
      .innerJoin(adAccounts, eq(agents.adAccountId, adAccounts.id))
      .innerJoin(orgs, eq(agents.orgId, orgs.id))
      .where(and(eq(agents.adAccountId, adAccountId), eq(agents.orgId, orgId)))
      .limit(1);
    const active = r && r.agentStatus === "active" && r.accountStatus === "active";
    if (!r || !active) {
      await removeAccountSchedule(adAccountId);
      return;
    }
    await upsertAccountSchedule({
      orgId,
      agentId: r.agentId,
      adAccountId,
      cron: cronFor(r.cadence),
      tz: r.tz,
      enabled: true,
    });
  }

  return {
    upsertAccountSchedule,
    removeAccountSchedule,
    ensureReaperSchedule,
    ensureApprovalExpirySchedule,
    ensureInsightsSweepSchedule,
    syncAllFromDb,
    resyncAccountSchedule,
  };
}

export type AccountCron = ReturnType<typeof makeAccountCron>;
