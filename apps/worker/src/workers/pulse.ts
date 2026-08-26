// Worker do PULSO proativo (F4 → P2): tick recorrente por conta (cadência própria).
// "Resumo do dia": retrato FRESCO da janela ontem+hoje (getFreshMetricsData) +
// recomendações que seguem valendo do último run, redigido na voz+postura do agente
// (redator leve). Honesto sobre a atribuição intradiária. Dedupe: nunca cola no push
// do cron/alerta. Degrada gracioso (Meta fora → narrativa do último run; LLM fora →
// fallback determinístico). A política de pulso liga/desliga no scheduler.

import { Worker } from "bullmq";
import type { Redis } from "ioredis";
import { and, desc, eq, gt, isNull } from "drizzle-orm";
import {
  adAccounts,
  agentRuns,
  agents,
  conversations,
  messages,
  recommendations,
} from "@trafego/db";
import { composeAgentVoice, cpaLabelFor, volumeToRecCount } from "@trafego/core";
import { AGENT_PULSE_QUEUE, type AgentCronDispatchPayload, type NotifyPolicy } from "@trafego/shared";
import { LLMProviderError } from "@trafego/shared/ports";
import type { WorkerDeps } from "../composition.js";
import { ownerAccessActive } from "../modules/access/owner-gate.js";
import { createAnalysisRepo } from "../modules/analysis/repo.js";
import { getFreshMetricsData } from "../modules/conversation/fresh-metrics.js";
import { comparePeriodsData } from "../graphs/whatsapp-conversation/read-data.js";
import { createNotifyRepo } from "../modules/notify/repo.js";
import { createSendToConversation } from "../modules/notify/send-to-contact.js";
import { buildPulseFallback, buildPulseMessages, PULSE_OUTPUT_JSON_SCHEMA, PULSE_OUTPUT_SCHEMA_NAME, type PulseInput } from "../modules/pulse/prompt.js";

/** Não manda pulso se o agente já falou nas últimas N horas (evita colar no push). */
const PULSE_DEDUP_HOURS = 6;
/** Recs do último run só "seguem valendo" se o run não for velho demais (senão só o fresco). */
const PULSE_MAX_RUN_AGE_HOURS = 48;
const MS_PER_HOUR = 3_600_000;
/** Janela do resumo do dia: ontem (fechado) + hoje até agora. */
const PULSE_WINDOW_DAYS = 2;
/** Temperatura do redator do pulso (mesma do redator de análise). */
const PULSE_TEMPERATURE = 0.2;
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
    .select({ notifyPolicy: agents.notifyPolicy, accountName: adAccounts.name, currency: adAccounts.currency, accountStatus: adAccounts.status, agentStatus: agents.status })
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
  const ref = await repo.loadTarget(payload.orgId);
  if (!ref) return "skipped_no_target";

  // dedupe: última outbound recente NESTA thread (DM ou broadcast do grupo) → não cola no push/alerta.
  const threadCond =
    ref.kind === "contact"
      ? and(eq(conversations.orgId, payload.orgId), eq(conversations.contactId, ref.contactId))
      : and(eq(conversations.orgId, payload.orgId), eq(conversations.groupId, ref.groupId), isNull(conversations.participantPhone));
  const [conv] = await db.select({ id: conversations.id }).from(conversations).where(threadCond).limit(1);
  if (conv) {
    const since = new Date(now - PULSE_DEDUP_HOURS * MS_PER_HOUR);
    const [recent] = await db
      .select({ id: messages.id })
      .from(messages)
      .where(and(eq(messages.conversationId, conv.id), eq(messages.direction, "outbound"), gt(messages.createdAt, since)))
      .limit(1);
    if (recent) return "skipped_recent";
  }

  // contexto do agente: voz (persona/tom/metodologia/personalização), postura, goals
  // (conversão → rótulo do CPA), timezone e modelo do redator.
  const ctx = await createAnalysisRepo(db).loadAgentContext(payload.orgId, payload.agentId);
  if (!ctx) return "skipped_disabled";
  const accountName = row.accountName ?? "sua conta";
  const sendToConversation = createSendToConversation({ messaging: deps.ports.messaging, repo });

  // último run: base das recomendações que "seguem valendo" + narrativa de fallback.
  const [run] = await db
    .select({ id: agentRuns.id, narrative: agentRuns.narrative, createdAt: agentRuns.createdAt })
    .from(agentRuns)
    .where(and(eq(agentRuns.agentId, payload.agentId), eq(agentRuns.orgId, payload.orgId), eq(agentRuns.status, USEFUL_RUN_STATUS)))
    .orderBy(desc(agentRuns.createdAt))
    .limit(1);
  const runFresh = run != null && now - run.createdAt.getTime() <= PULSE_MAX_RUN_AGE_HOURS * MS_PER_HOUR;

  // retrato FRESCO da janela ontem+hoje (live Meta, degrada ao snapshot salvo sozinho).
  const fresh = await getFreshMetricsData(
    { db, vault: deps.ports.vault, insightsSync: deps.insightsSync, logger },
    { orgId: payload.orgId, agentId: payload.agentId, adAccountId: payload.adAccountId, timezone: ctx.timezone },
    { periodDays: PULSE_WINDOW_DAYS },
  );
  if ("error" in fresh) {
    // sem dado fresco nem salvo → degrada pra narrativa persistida do último run (se houver).
    if (runFresh && run?.narrative) {
      await sendToConversation(ref, run.narrative, { split: false, meta: { pulse: true } });
      logger.info({ agentId: payload.agentId, orgId: payload.orgId }, "pulse:enviado (degradado p/ narrativa do run)");
      return "sent";
    }
    return "skipped_no_run";
  }

  // recs que seguem valendo (só de run fresco), capadas pelo VOLUME da postura.
  let standingRecs: string[] = [];
  if (runFresh && run) {
    const recs = await db
      .select({ title: recommendations.title })
      .from(recommendations)
      .where(and(eq(recommendations.runId, run.id), eq(recommendations.orgId, payload.orgId)));
    standingRecs = recs.map((r) => r.title).slice(0, volumeToRecCount(ctx.posture.volume));
  }

  const cmp = await comparePeriodsData(db, payload.adAccountId, payload.orgId, PULSE_WINDOW_DAYS, ctx.timezone);

  const pulseInput: PulseInput = {
    accountName,
    currency: row.currency ?? "BRL",
    kpis: fresh.kpis,
    updated: fresh.updated,
    spendDeltaPct: cmp.deltaPct,
    cpaLabel: cpaLabelFor(ctx.goals.conversionGoal ?? null),
    standingRecs,
    noAnalysisYet: !runFresh,
  };

  // redator leve voiceado (voz + postura); fallback determinístico em erro/JSON.
  const voice = composeAgentVoice(ctx);
  const mm = ctx.modelConfig?.["messageModel"];
  const messageModel = typeof mm === "string" && mm.length > 0 ? mm : deps.analysis.messageModel;
  let text: string | null = null;
  try {
    const completion = await deps.ports.llm.completeStructured<{ text: string }>({
      model: messageModel,
      messages: buildPulseMessages(voice, ctx.posture, pulseInput),
      responseSchema: PULSE_OUTPUT_JSON_SCHEMA,
      responseSchemaName: PULSE_OUTPUT_SCHEMA_NAME,
      temperature: PULSE_TEMPERATURE,
      meta: { orgId: payload.orgId, type: "message" },
    });
    const t = completion.output?.text;
    if (typeof t === "string" && t.trim().length > 0) text = t.trim();
  } catch (err) {
    if (!(err instanceof LLMProviderError)) throw err;
    logger.warn({ agentId: payload.agentId, err }, "pulse:redator falhou; usando fallback");
  }
  if (!text) text = buildPulseFallback(pulseInput);

  await sendToConversation(ref, text, { split: false, meta: { pulse: true } });
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
