/**
 * Contrato do job de análise (Grafo A), compartilhado entre o produtor (API) e o
 * consumidor (worker) — evita string mágica e drift de payload entre processos.
 * A fila é a mesma ("agent-runs"); o worker distingue por `mode` (execute|resume).
 */
import type { JobSpec } from "../ports/scheduler.port.js";
import type { SignalFinding } from "../types/index.js";
import type { ConversationRef } from "./whatsapp.js";

export const AGENT_RUNS_QUEUE = "agent-runs";
export const AGENT_RUN_JOB = "agent-run";

/**
 * Fila do DISPATCH do cron (3b): o Job Scheduler recorrente enfileira aqui; o
 * worker de dispatch cria o `agent_runs` (+guards) e então enfileira o `execute`
 * na AGENT_RUNS_QUEUE. Separar mantém o scheduler burro (não cria run) e o
 * dispatch idempotente (índice único in-flight fecha o TOCTOU).
 */
export const AGENT_CRON_QUEUE = "agent-cron-dispatch";
export const AGENT_CRON_JOB = "agent-cron";

/**
 * Pulso proativo (F4): resumo periódico da conta MESMO sem recomendação (o
 * "não deixa a conta morrer"). Fila/scheduler próprios (cadência independente da
 * análise). Reusa o último run persistido — sem rerun caro; dedupe evita colar no push.
 */
export const AGENT_PULSE_QUEUE = "agent-pulse";
export const pulseScheduleKey = (adAccountId: string): string => `pulse:${adAccountId}`;

/**
 * Fila do REAPER (3b): um Job Scheduler recorrente enfileira aqui; o worker marca
 * como `failed` os runs presos in-flight (crash duro entre criar o run e fechá-lo)
 * — sem isso o índice único parcial travaria o agente p/ sempre. Chave estável.
 */
export const AGENT_REAPER_QUEUE = "agent-run-reaper";
export const AGENT_REAPER_JOB = "agent-run-reaper";
export const AGENT_REAPER_SCHEDULE_KEY = "reaper:runs";

/** Tick do reaper — sem payload (varre todos os orgs). */
export type AgentReaperTickPayload = Record<string, never>;

/**
 * Fila de EXPIRAÇÃO de aprovações (5b): um Job Scheduler recorrente enfileira aqui; o
 * worker marca como `expired` as pendentes vencidas (24h sem resposta). Chave estável.
 */
export const APPROVAL_EXPIRY_QUEUE = "approval-expiry";
export const APPROVAL_EXPIRY_SCHEDULE_KEY = "expiry:approvals";
export type ApprovalExpiryTickPayload = Record<string, never>;

/**
 * Fila do JOB DE APRENDIZADO (aprendizado contínuo): um Job Scheduler recorrente (diário)
 * enfileira aqui; o worker destila padrões do histórico de análise em lições, mede o
 * outcome de ações aplicadas (S4) e faz a curadoria (decaimento). Nome durável — não
 * nomeado por um mecanismo (§13). Chave estável (singleton, varre todos os agentes ativos).
 */
export const AGENT_LEARNING_QUEUE = "agent-learning";
export const AGENT_LEARNING_SCHEDULE_KEY = "learning:agents";
export type AgentLearningTickPayload = Record<string, never>;

/**
 * Fila de PURGE do contexto de grupo (retenção/LGPD): um Job Scheduler recorrente (diário)
 * enfileira aqui; o worker apaga as mensagens ambiente de grupo além da janela de retenção.
 */
export const GROUP_CONTEXT_PURGE_QUEUE = "group-context-purge";
export const GROUP_CONTEXT_PURGE_SCHEDULE_KEY = "purge:group-context";
export type GroupContextPurgeTickPayload = Record<string, never>;

/**
 * Fila de RE-SYNC do schedule (Fatia 4 corte 2): a API só persiste a cadência e
 * enfileira aqui; o WORKER (dono único do scheduler) recarrega o `CadenceSpec` da
 * conta + o fuso da org, deriva o cron e faz upsert/remove. Mantém a API fora do
 * domínio de agenda (sem builder de ScheduleSpec na casca HTTP).
 */
export const SCHEDULE_RESYNC_QUEUE = "schedule-resync";
export const SCHEDULE_RESYNC_JOB = "schedule-resync";
export type ScheduleResyncPayload = {
  readonly orgId: string;
  readonly adAccountId: string;
};

/**
 * Fila de UNDO de ação (5a): a API valida a posse + enfileira; o WORKER (dono do
 * governor/escrita) carrega o `agent_tool_calls`, reaplica o `before_state` na Meta
 * e registra o undo. Escrita fica no worker (governor + auditoria), não na casca HTTP.
 */
export const ACTION_UNDO_QUEUE = "action-undo";
export const ACTION_UNDO_JOB = "action-undo";
export type ActionUndoPayload = {
  readonly orgId: string;
  readonly adAccountId: string;
  readonly toolCallId: string;
  /** ignora o re-check de drift ("reverter mesmo assim") — 5b. */
  readonly force?: boolean;
  /** reversão de CRIAÇÃO/escala (Slice 11): pausar (default) ou arquivar a árvore criada. */
  readonly mode?: "pause" | "archive";
};

/**
 * Fila de APLICAÇÃO de aprovação (5b): a API valida a posse + enfileira; o WORKER
 * carrega a `approval`, RE-CHECA o estado fresco na Meta + guardrail e aplica via o
 * executor. Escrita no worker (governor + auditoria), nunca na casca HTTP. Deriva a
 * conta do próprio approval (não confia em payload extra).
 */
export const APPROVAL_APPLY_QUEUE = "approval-apply";
export const APPROVAL_APPLY_JOB = "approval-apply";
export type ApprovalApplyPayload = {
  readonly orgId: string;
  readonly approvalId: string;
  /** conversa (DM ou grupo) p/ empurrar o desfecho no WhatsApp (5b-2 — aprovação conversacional). */
  readonly notifyRef?: ConversationRef;
};

/** Retry de APLICAÇÃO em rate-limit da Meta (#613, D3): a escrita é idempotente (idempotency_key
 *  `${approval}:apply`), então re-tentar com backoff é seguro. Só o kind `rate_limited` re-lança
 *  (approval-apply.ts decide); demais falhas resolvem no 1º giro. Backoff longo (a janela do #613
 *  é de minutos). */
export const APPROVAL_APPLY_ATTEMPTS = 4;
export const APPROVAL_APPLY_BACKOFF_MS = 30_000;

/** Fonte única do job de aplicação de aprovação (com attempts/backoff p/ o retry de rate-limit). */
export function buildApprovalApplyJob(payload: ApprovalApplyPayload): JobSpec {
  return {
    queue: APPROVAL_APPLY_QUEUE,
    name: APPROVAL_APPLY_JOB,
    payload,
    attempts: APPROVAL_APPLY_ATTEMPTS,
    backoffMs: APPROVAL_APPLY_BACKOFF_MS,
    removeOnComplete: true,
    removeOnFail: true,
  };
}

export type AgentRunTrigger = "cron" | "on_demand" | "conversation" | "signal" | "onboarding";

/** Alvo de push do resultado (5b-2): run disparado pelo WhatsApp devolve na conversa. */
export type RunNotifyTarget = {
  readonly ref: ConversationRef;
  readonly conversationId: string;
};

/** Payload do dispatch de cron: sem `runId` (o dispatch é quem cria o run). */
export type AgentCronDispatchPayload = {
  readonly orgId: string;
  readonly agentId: string;
  readonly adAccountId: string;
};

/**
 * Novo run de análise (cron ou on-demand). O run já nasce criado (pending) na API.
 * `type` (não `interface`) p/ ganhar o index signature implícito → aceito como
 * `JobSpec.payload` (Record<string, unknown>) sem cast.
 */
export type AgentRunExecutePayload = {
  readonly mode: "execute";
  readonly trigger: AgentRunTrigger;
  /** id de `agent_runs` (criado pela API; o worker abre→fecha). */
  readonly runId: string;
  /** org dona — o worker re-escopa toda query (defesa cross-tenant, §12). */
  readonly orgId: string;
  readonly agentId: string;
  /** id de `ad_accounts` (o worker carrega + descriptografa o token). */
  readonly adAccountId: string;
  /** alvo de push (5b-2): quando disparado pelo WhatsApp, o resultado volta na conversa. */
  readonly notify?: RunNotifyTarget;
  /** sinal que DISPAROU o run (trigger "signal", F4): dirige o olhar do analista. */
  readonly signalFinding?: SignalFinding;
};
