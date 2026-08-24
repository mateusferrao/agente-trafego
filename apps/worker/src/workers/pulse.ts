// Worker do PULSO proativo (F4): tick recorrente por conta (cadência própria).
// Resume a conta a partir do ÚLTIMO run persistido (sem rerun/LLM) e empurra 1
// mensagem — MAS só se o agente não falou faz pouco (dedupe: nunca cola no push do
// cron/alerta). Determinístico e barato; a política de pulso liga/desliga no scheduler.

import { Worker } from "bullmq";
import type { Redis } from "ioredis";
import { and, desc, eq, gt } from "drizzle-orm";
import {
  adAccounts,
  agentRuns,
  agents,
  conversations,
  messages,
  recommendations,
} from "@trafego/db";
import { buildMessageFallback } from "@trafego/core";
import { AGENT_PULSE_QUEUE, type AgentCronDispatchPayload, type NotifyPolicy } from "@trafego/shared";
import type { WorkerDeps } from "../composition.js";
import { ownerAccessActive } from "../modules/access/owner-gate.js";
import { createNotifyRepo } from "../modules/notify/repo.js";
import { createSendToContact } from "../modules/notify/send-to-contact.js";
import { composePulseOverview } from "../modules/pulse/compose.js";

/** Não manda pulso se o agente já falou nas últimas N horas (evita colar no push). */
const PULSE_DEDUP_HOURS = 6;
/** Não manda pulso sobre um run velho demais (dado stale) — melhor calar que mentir. */
const PULSE_MAX_RUN_AGE_HOURS = 48;
const MS_PER_HOUR = 3_600_000;
// Só runs que produziram síntese (degradado é `succeeded`+partial). Incluir `failed`
// mascararia o último run bom (sem snapshot) e calaria o pulso justo quando falhou.
const USEFUL_RUN_STATUS = "succeeded" as const;

export type PulseOutcome =
  | "sent"
  | "skipped_disabled"
  | "skipped_access"
  | "skipped_recent"
  | "skipped_no_target"
  | "skipped_no_run"
  | "skipped_stale";

export async function runPulse(deps: WorkerDeps, payload: AgentCronDispatchPayload): Promise<PulseOutcome> {
  const { db, logger } = deps;
  const now = Date.now();

  // agente + conta ativos + política + nome da conta.
  const [row] = await db
    .select({ notifyPolicy: agents.notifyPolicy, accountName: adAccounts.name, accountStatus: adAccounts.status, agentStatus: agents.status })
    .from(agents)
    .innerJoin(adAccounts, eq(agents.adAccountId, adAccounts.id))
    .where(and(eq(agents.id, payload.agentId), eq(agents.orgId, payload.orgId)))
    .limit(1);
  const policy = row?.notifyPolicy as NotifyPolicy | undefined;
  if (!row || row.agentStatus !== "active" || row.accountStatus !== "active" || !policy?.pulse.enabled) {
    return "skipped_disabled";
  }

  // gate de beta: proativo age em nome da org → mesmo gate do dispatcher (org com
  // acesso revogado não recebe pulso, mesmo com agente/conta ainda ativos).
  if (!(await ownerAccessActive(db, payload.orgId))) return "skipped_access";

  const repo = createNotifyRepo(db);
  const target = await repo.loadTarget(payload.orgId);
  if (!target) return "skipped_no_target";

  // dedupe: última outbound recente do contato → não cola no push/alerta.
  const [conv] = await db
    .select({ id: conversations.id })
    .from(conversations)
    .where(and(eq(conversations.orgId, payload.orgId), eq(conversations.contactId, target.contactId)))
    .limit(1);
  if (conv) {
    const since = new Date(now - PULSE_DEDUP_HOURS * MS_PER_HOUR);
    const [recent] = await db
      .select({ id: messages.id })
      .from(messages)
      .where(and(eq(messages.conversationId, conv.id), eq(messages.direction, "outbound"), gt(messages.createdAt, since)))
      .limit(1);
    if (recent) return "skipped_recent";
  }

  // último run finalizado → overview do pulso (money-shot).
  const [run] = await db
    .select({ id: agentRuns.id, summary: agentRuns.summary, metricsSnapshot: agentRuns.metricsSnapshot, createdAt: agentRuns.createdAt })
    .from(agentRuns)
    .where(and(eq(agentRuns.agentId, payload.agentId), eq(agentRuns.orgId, payload.orgId), eq(agentRuns.status, USEFUL_RUN_STATUS)))
    .orderBy(desc(agentRuns.createdAt))
    .limit(1);
  if (!run) return "skipped_no_run";
  // run velho demais (ex: crons falhando há dias) → não empurra dado stale como "pulso".
  if (now - run.createdAt.getTime() > PULSE_MAX_RUN_AGE_HOURS * MS_PER_HOUR) return "skipped_stale";

  const recs = await db
    .select({ title: recommendations.title })
    .from(recommendations)
    .where(and(eq(recommendations.runId, run.id), eq(recommendations.orgId, payload.orgId)));

  const overview = composePulseOverview({
    accountName: row.accountName ?? "sua conta",
    summary: run.summary,
    snapshot: (run.metricsSnapshot ?? null) as Parameters<typeof composePulseOverview>[0]["snapshot"],
    recommendationTitles: recs.map((r) => r.title),
  });
  if (!overview) return "skipped_no_run";

  const sendToContact = createSendToContact({ messaging: deps.ports.messaging, repo });
  await sendToContact(target.contactId, buildMessageFallback(overview), { split: false, meta: { pulse: true } });
  logger.info({ agentId: payload.agentId, orgId: payload.orgId }, "pulse:enviado");
  return "sent";
}

export function startPulseWorker(deps: WorkerDeps, connection: Redis): Worker<AgentCronDispatchPayload> {
  return new Worker<AgentCronDispatchPayload>(
    AGENT_PULSE_QUEUE,
    async (job) => {
      // fila dedicada ao pulso — todo job é um tick do scheduler pulse:{id}.
      const outcome = await runPulse(deps, job.data);
      deps.logger.info({ jobId: job.id, adAccountId: job.data.adAccountId, outcome }, "pulse:tick");
    },
    { connection },
  );
}
