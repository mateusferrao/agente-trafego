// Ações de MUTAÇÃO de aprendizado (v3) — casca de IO ÚNICA reusada pela API (site) e pelo chat
// do worker (WhatsApp). Sem duplicar a lógica de aceite/rejeição/reversão/dispensa em dois
// lugares (§13 "3x → extrai", reuso-1º). Retornam um Result tipado (nunca lançam) → cada
// consumidor mapeia: a API → HTTP (notFound/badRequest); o chat → texto. HARD-WALL: os patches
// de limiar só tocam `model_config.quality` (nunca guardrail_configs/autonomy_policy).

import { and, eq, sql } from "drizzle-orm";
import { advisoryDismissals, agentMemory, agents, type Database } from "@trafego/db";
import { computeConfidence, nextThresholdValue, type ThresholdProposal } from "@trafego/core";
import type { SchedulerPort } from "@trafego/shared/ports";
import type { OrgId } from "@trafego/shared/types";
import { applyAgentConfigChange } from "./index.js";

/** Chave genérica do aviso de teto (dispensa por-agente) — fonte ÚNICA p/ site + chat (§13). */
export const GUARDRAIL_OPPORTUNITY_KEY = "guardrail_opportunity:maxBudgetChangePct";
// Cooldown (dias) da dispensa do aviso = configurável por env (LEARNING_ADVISORY_DISMISS_COOLDOWN_DAYS),
// injetado pelos consumidores (api service / worker chat) — não mais um literal aqui (§13).

/** Resultado tipado de uma ação — `code` deixa o consumidor mapear pra HTTP/texto. */
export type LearningActionResult = { readonly ok: true } | { readonly ok: false; readonly code: "not_found" | "bad_request"; readonly error: string };

const notFound = (error: string): LearningActionResult => ({ ok: false, code: "not_found", error });
const badRequest = (error: string): LearningActionResult => ({ ok: false, code: "bad_request", error });
const ok: LearningActionResult = { ok: true };

/** Ator da mutação (auditoria) — "user" (site) ou o rótulo do contato/grupo (chat). */
export interface LearningActor {
  readonly label: string;
  readonly userId?: string;
}

export interface LearningActionDeps {
  readonly db: Database;
  readonly scheduler: SchedulerPort;
  /** defaults globais dos limiares de qualidade (fallback quando o agente não tem override). */
  readonly qualityDefaults: Readonly<Record<string, unknown>>;
}

export interface LessonRef {
  readonly orgId: OrgId;
  readonly agentId: string;
  readonly lessonId: string;
}

/** Patch de limiar APLICADO — guarda o valor anterior p/ o Reverter restaurar. */
export interface AppliedThresholdPatch {
  readonly threshold: string;
  readonly previousValue: number;
  readonly behaviorLabel: string;
}

/** Predicado org+agente+id — fecha o check-then-act do UPDATE (defesa em profundidade §12). */
function scoped(ref: LessonRef) {
  return and(eq(agentMemory.id, ref.lessonId), eq(agentMemory.orgId, ref.orgId), eq(agentMemory.agentId, ref.agentId));
}

const notArchived = sql`${agentMemory.lifecycle} <> 'archived'`;

/** Esquece (soft-archive) um aprendizado — nunca hard-delete (preserva a trilha). */
export async function forgetLesson(db: Database, ref: LessonRef): Promise<LearningActionResult> {
  const [row] = await db.select({ id: agentMemory.id }).from(agentMemory).where(and(scoped(ref), notArchived)).limit(1);
  if (!row) return notFound("Aprendizado não encontrado.");
  await db.update(agentMemory).set({ lifecycle: "archived", updatedAt: sql`now()` }).where(scoped(ref));
  return ok;
}

/** Restaura um aprendizado ARQUIVADO → volta a ativo (desfaz o "esquecer"). */
export async function restoreLesson(db: Database, ref: LessonRef): Promise<LearningActionResult> {
  const [row] = await db
    .select({ id: agentMemory.id })
    .from(agentMemory)
    .where(and(eq(agentMemory.id, ref.lessonId), eq(agentMemory.orgId, ref.orgId), eq(agentMemory.agentId, ref.agentId), eq(agentMemory.lifecycle, "archived")))
    .limit(1);
  if (!row) return notFound("Aprendizado arquivado não encontrado.");
  await db.update(agentMemory).set({ lifecycle: "active", updatedAt: sql`now()` }).where(scoped(ref));
  return ok;
}

/** Confirma um aprendizado (o dono endossa) → confirmedByHuman + salto de confiança. */
export async function confirmLesson(db: Database, ref: LessonRef): Promise<LearningActionResult> {
  const [row] = await db.select({ confidence: agentMemory.confidence }).from(agentMemory).where(and(scoped(ref), notArchived)).limit(1);
  if (!row) return notFound("Aprendizado não encontrado.");
  const confidence = computeConfidence(row.confidence, { type: "confirm" });
  await db.update(agentMemory).set({ confirmedByHuman: true, confidence, lifecycle: "active", updatedAt: sql`now()` }).where(scoped(ref));
  return ok;
}

/**
 * Aceita a proposta de ajuste de limiar: calcula o novo valor a partir do ATUAL e aplica em
 * `model_config.quality` (auditado). Guarda o valor anterior p/ o Reverter. NUNCA toca
 * guardrail/autonomia. Depois: limpa a proposta e confirma a lição.
 */
export async function acceptThreshold(deps: LearningActionDeps, ref: LessonRef, actor: LearningActor): Promise<LearningActionResult> {
  const [row] = await deps.db
    .select({ patch: agentMemory.proposedThresholdPatch, confidence: agentMemory.confidence, adAccountId: agents.adAccountId, modelConfig: agents.modelConfig })
    .from(agentMemory)
    .innerJoin(agents, eq(agentMemory.agentId, agents.id))
    .where(and(scoped(ref), notArchived))
    .limit(1);
  if (!row) return notFound("Aprendizado não encontrado.");
  const proposal = row.patch as ThresholdProposal | null;
  if (!proposal) return badRequest("Este aprendizado não tem uma proposta de ajuste.");

  const quality = (row.modelConfig?.quality as Record<string, unknown> | undefined) ?? {};
  const currentRaw = quality[proposal.threshold] ?? deps.qualityDefaults[proposal.threshold];
  if (typeof currentRaw !== "number") return badRequest("Não consegui ler o limiar atual para ajustar.");
  const newValue = nextThresholdValue(currentRaw, proposal);

  const result = await applyAgentConfigChange(
    { db: deps.db, scheduler: deps.scheduler },
    {
      orgId: ref.orgId,
      agentId: ref.agentId,
      accountId: row.adAccountId,
      patch: { modelConfig: { quality: { [proposal.threshold]: newValue } } },
      audit: { actor, metadata: { source: "learning_threshold_accept", lessonId: ref.lessonId } },
    },
  );
  if (!result.ok) return badRequest(result.error);

  const applied: AppliedThresholdPatch = { threshold: proposal.threshold, previousValue: currentRaw, behaviorLabel: proposal.behaviorLabel };
  const confidence = computeConfidence(row.confidence, { type: "confirm" });
  await deps.db
    .update(agentMemory)
    .set({ proposedThresholdPatch: null, appliedThresholdPatch: { ...applied }, confirmedByHuman: true, confidence, thresholdResolvedAt: null, updatedAt: sql`now()` })
    .where(scoped(ref));
  return ok;
}

/** Rejeita a proposta de limiar: descarta o patch SEM tocar config e marca resolvido (trava a re-oferta). */
export async function rejectProposal(db: Database, ref: LessonRef): Promise<LearningActionResult> {
  const [row] = await db.select({ patch: agentMemory.proposedThresholdPatch }).from(agentMemory).where(and(scoped(ref), notArchived)).limit(1);
  if (!row) return notFound("Aprendizado não encontrado.");
  if (!row.patch) return badRequest("Este aprendizado não tem uma proposta de ajuste.");
  await db.update(agentMemory).set({ proposedThresholdPatch: null, thresholdResolvedAt: sql`now()`, updatedAt: sql`now()` }).where(scoped(ref));
  return ok;
}

/** Reverte um limiar já aceito: restaura o valor ANTERIOR (auditado) e marca resolvido. */
export async function revertThreshold(deps: LearningActionDeps, ref: LessonRef, actor: LearningActor): Promise<LearningActionResult> {
  const [row] = await deps.db
    .select({ applied: agentMemory.appliedThresholdPatch, adAccountId: agents.adAccountId })
    .from(agentMemory)
    .innerJoin(agents, eq(agentMemory.agentId, agents.id))
    .where(and(scoped(ref), notArchived))
    .limit(1);
  if (!row) return notFound("Aprendizado não encontrado.");
  const applied = row.applied as AppliedThresholdPatch | null;
  if (!applied) return badRequest("Este aprendizado não tem um ajuste aplicado para reverter.");

  const result = await applyAgentConfigChange(
    { db: deps.db, scheduler: deps.scheduler },
    {
      orgId: ref.orgId,
      agentId: ref.agentId,
      accountId: row.adAccountId,
      patch: { modelConfig: { quality: { [applied.threshold]: applied.previousValue } } },
      audit: { actor, metadata: { source: "learning_threshold_revert", lessonId: ref.lessonId } },
    },
  );
  if (!result.ok) return badRequest(result.error);

  await deps.db
    .update(agentMemory)
    .set({ appliedThresholdPatch: null, thresholdResolvedAt: sql`now()`, updatedAt: sql`now()` })
    .where(scoped(ref));
  return ok;
}

export interface AdvisoryDismissRef {
  readonly orgId: OrgId;
  readonly agentId: string;
  /** chave do aviso (genérica), ex: `guardrail_opportunity:maxBudgetChangePct`. */
  readonly key: string;
  /** cooldown: o aviso só reaparece depois disso (ou se piorar materialmente). */
  readonly dismissedUntil: Date;
}

/** Dispensa um AVISO (ex: oportunidade de teto) por um cooldown — upsert por (agente, key). */
export async function dismissAdvisory(db: Database, ref: AdvisoryDismissRef): Promise<LearningActionResult> {
  const [agent] = await db.select({ id: agents.id }).from(agents).where(and(eq(agents.id, ref.agentId), eq(agents.orgId, ref.orgId))).limit(1);
  if (!agent) return notFound("Agente não encontrado.");
  await db
    .insert(advisoryDismissals)
    .values({ orgId: ref.orgId, agentId: ref.agentId, key: ref.key, dismissedUntil: ref.dismissedUntil })
    .onConflictDoUpdate({ target: [advisoryDismissals.agentId, advisoryDismissals.key], set: { dismissedUntil: ref.dismissedUntil, updatedAt: sql`now()` } });
  return ok;
}
