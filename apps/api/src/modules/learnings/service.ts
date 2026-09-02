import { and, desc, eq, gt, inArray, isNotNull, sql } from "drizzle-orm";
import { advisoryDismissals, agentMemory, agentRuns, agents, type Database } from "@trafego/db";
import { confidenceTier, LEARNING_MEMORY_TYPES, lessonKindFromMemoryType, type GuardrailOpportunity, type ThresholdProposal } from "@trafego/core";
import {
  acceptThreshold as acceptThresholdAction,
  confirmLesson,
  dismissAdvisory,
  forgetLesson,
  rejectProposal as rejectProposalAction,
  restoreLesson,
  revertThreshold as revertThresholdAction,
  type LearningActionResult,
} from "@trafego/agent-config";
import type { SchedulerPort } from "@trafego/shared/ports";
import type { OrgId } from "@trafego/shared/types";
import { notFound, badRequest } from "../../middleware/error-handler.js";
import type { LearningItem, LearningOk, LearningOpportunity, LearningsList } from "./schema.js";

export interface LearningsDeps {
  readonly db: Database;
  readonly scheduler: SchedulerPort;
  /** defaults globais dos limiares de qualidade (fallback quando o agente não tem override). */
  readonly qualityDefaults: Readonly<Record<string, unknown>>;
}

// só os tipos de APRENDIZADO (o `rejected`/`objective` legado não aparece na aba) —
// fonte única em @trafego/core (LEARNING_MEMORY_TYPES, derivado de MEMORY_TYPE_BY_KIND).
const LEARNING_TYPES = LEARNING_MEMORY_TYPES;

/** Patch de limiar APLICADO — guarda o valor anterior p/ o Reverter (v3) restaurar. */
interface AppliedThresholdPatch {
  readonly threshold: string;
  readonly previousValue: number;
  readonly behaviorLabel: string;
}

/** Chave genérica do aviso de teto (dispensa por-agente). */
const GUARDRAIL_OPPORTUNITY_KEY = "guardrail_opportunity:maxBudgetChangePct";

/** Mapeia o Result tipado das ações compartilhadas → exceção HTTP amigável. */
function unwrap(result: LearningActionResult): LearningOk {
  if (result.ok) return { ok: true };
  throw result.code === "not_found" ? notFound(result.error) : badRequest(result.error);
}

/**
 * Slice de aprendizados (aba "Aprendizados"): lista (priors + propostas + oportunidades +
 * arquivados) e as mutações (confirmar/esquecer/aprovar/rejeitar/reverter/dispensar). As
 * mutações delegam à casca ÚNICA em @trafego/agent-config (reusada pelo chat do worker).
 * Org-scoped (sem vazamento cross-tenant).
 */
export function createLearningsService(deps: LearningsDeps) {
  async function list(orgId: OrgId, agentId: string): Promise<LearningsList> {
    // valida que o agente é da org (404 amigável em vez de lista vazia silenciosa).
    const [agent] = await deps.db
      .select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.id, agentId), eq(agents.orgId, orgId)))
      .limit(1);
    if (!agent) throw notFound("Agente não encontrado.");

    const rows = await deps.db
      .select()
      .from(agentMemory)
      .where(
        and(
          eq(agentMemory.orgId, orgId),
          eq(agentMemory.agentId, agentId),
          inArray(agentMemory.type, [...LEARNING_TYPES]),
          isNotNull(agentMemory.semanticKey),
        ),
      )
      .orderBy(desc(agentMemory.confirmedByHuman), desc(agentMemory.confidence));

    // ativos/stale = a aba viva; arquivados = zona recolhida (filtro/busca + restaurar).
    const items: LearningItem[] = [];
    const archived: LearningItem[] = [];
    for (const r of rows) {
      const item = toItem(r);
      (r.lifecycle === "archived" ? archived : items).push(item);
    }
    const opportunities = await loadOpportunities(orgId, agentId);
    return { items, opportunities, archived };
  }

  /** Zona "Oportunidades": deriva o aviso de teto vivo do ÚLTIMO run, menos dispensas em cooldown. */
  async function loadOpportunities(orgId: OrgId, agentId: string): Promise<LearningOpportunity[]> {
    const [run] = await deps.db
      .select({ snapshot: agentRuns.metricsSnapshot })
      .from(agentRuns)
      .where(and(eq(agentRuns.orgId, orgId), eq(agentRuns.agentId, agentId), isNotNull(agentRuns.metricsSnapshot)))
      .orderBy(desc(agentRuns.createdAt))
      .limit(1);
    const op = (run?.snapshot as { guardrailOpportunity?: GuardrailOpportunity } | null)?.guardrailOpportunity;
    if (!op) return [];
    // dispensado e ainda em cooldown? some da lista (sinal vivo respeita a dispensa).
    const [dismissed] = await deps.db
      .select({ id: advisoryDismissals.id })
      .from(advisoryDismissals)
      .where(and(eq(advisoryDismissals.agentId, agentId), eq(advisoryDismissals.key, GUARDRAIL_OPPORTUNITY_KEY), gt(advisoryDismissals.dismissedUntil, sql`now()`)))
      .limit(1);
    if (dismissed) return [];
    return [{ key: GUARDRAIL_OPPORTUNITY_KEY, threshold: op.threshold, wantedPct: op.wantedPct, cappedPct: op.cappedPct, foregoneMinor: op.foregoneMinor }];
  }

  /** Verifica que a lição é do agente/org e não está arquivada (404 amigável). */
  async function requireLesson(orgId: OrgId, agentId: string, lessonId: string): Promise<void> {
    const [row] = await deps.db
      .select({ id: agentMemory.id })
      .from(agentMemory)
      .where(
        and(
          eq(agentMemory.id, lessonId),
          eq(agentMemory.orgId, orgId),
          eq(agentMemory.agentId, agentId),
          inArray(agentMemory.type, [...LEARNING_TYPES]),
          sql`${agentMemory.lifecycle} <> 'archived'`,
        ),
      )
      .limit(1);
    if (!row) throw notFound("Aprendizado não encontrado.");
  }

  /** Reescreve a frase do aprendizado (o usuário corrige com as próprias palavras). */
  async function edit(orgId: OrgId, agentId: string, lessonId: string, content: string): Promise<LearningOk> {
    await requireLesson(orgId, agentId, lessonId);
    await deps.db
      .update(agentMemory)
      .set({ content, updatedAt: sql`now()` })
      .where(and(eq(agentMemory.id, lessonId), eq(agentMemory.orgId, orgId), eq(agentMemory.agentId, agentId)));
    return { ok: true };
  }

  const ACTOR = { label: "user" } as const;

  async function confirm(orgId: OrgId, agentId: string, lessonId: string): Promise<LearningOk> {
    return unwrap(await confirmLesson(deps.db, { orgId, agentId, lessonId }));
  }

  async function forget(orgId: OrgId, agentId: string, lessonId: string): Promise<LearningOk> {
    return unwrap(await forgetLesson(deps.db, { orgId, agentId, lessonId }));
  }

  async function restore(orgId: OrgId, agentId: string, lessonId: string): Promise<LearningOk> {
    return unwrap(await restoreLesson(deps.db, { orgId, agentId, lessonId }));
  }

  async function acceptThreshold(orgId: OrgId, agentId: string, lessonId: string): Promise<LearningOk> {
    return unwrap(await acceptThresholdAction(deps, { orgId, agentId, lessonId }, ACTOR));
  }

  async function rejectProposal(orgId: OrgId, agentId: string, lessonId: string): Promise<LearningOk> {
    return unwrap(await rejectProposalAction(deps.db, { orgId, agentId, lessonId }));
  }

  async function revertThreshold(orgId: OrgId, agentId: string, lessonId: string): Promise<LearningOk> {
    return unwrap(await revertThresholdAction(deps, { orgId, agentId, lessonId }, ACTOR));
  }

  /** Dispensa o aviso de teto por um cooldown (a UI/chat oferece "Dispensar"). */
  async function dismissOpportunity(orgId: OrgId, agentId: string, cooldownDays: number): Promise<LearningOk> {
    const until = new Date(Date.now() + cooldownDays * 24 * 60 * 60 * 1000);
    return unwrap(await dismissAdvisory(deps.db, { orgId, agentId, key: GUARDRAIL_OPPORTUNITY_KEY, dismissedUntil: until }));
  }

  return { list, edit, confirm, forget, restore, acceptThreshold, rejectProposal, revertThreshold, dismissOpportunity };
}

/** Projeta uma linha de agent_memory no item da aba (mesma forma p/ ativos e arquivados). */
function toItem(r: typeof agentMemory.$inferSelect): LearningItem {
  return {
    id: r.id,
    kind: lessonKindFromMemoryType(r.type),
    content: r.content,
    tier: confidenceTier(r.confidence ?? 0, r.confirmedByHuman),
    origin: r.origin,
    scope: r.scope,
    dimension: r.dimension ?? null,
    confirmedByHuman: r.confirmedByHuman,
    lifecycle: r.lifecycle,
    reinforceCount: r.reinforceCount,
    sourceRunId: r.sourceRunId ?? null,
    createdAt: r.createdAt.toISOString(),
    proposedBehavior: (r.proposedThresholdPatch as ThresholdProposal | null)?.behaviorLabel ?? null,
    appliedBehavior: (r.appliedThresholdPatch as AppliedThresholdPatch | null)?.behaviorLabel ?? null,
  };
}
