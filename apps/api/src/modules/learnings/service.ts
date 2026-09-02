import { and, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { agentMemory, agents, type Database } from "@trafego/db";
import { computeConfidence, confidenceTier, lessonKindFromMemoryType } from "@trafego/core";
import type { OrgId } from "@trafego/shared/types";
import { notFound } from "../../middleware/error-handler.js";
import type { LearningItem, LearningOk, LearningsList } from "./schema.js";

export interface LearningsDeps {
  readonly db: Database;
}

// só os tipos de APRENDIZADO (o `rejected`/`objective` legado não aparece na aba).
const LEARNING_TYPES = ["fact", "past_action"] as const;

/**
 * Slice de aprendizados (S1, read-only): lista as lições curadas de um agente para a
 * aba "Aprendizados". Org-scoped (filtra por orgId — sem vazamento cross-tenant, mesmo
 * com agentId adivinhado). Edição/confirmação/esquecer = S5.
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
          // só lições reais (chave semântica) — mesma fronteira do worker; não vaza
          // eventual linha legada fact/past_action sem chave para a aba.
          isNotNull(agentMemory.semanticKey),
          sql`${agentMemory.lifecycle} <> 'archived'`,
        ),
      )
      .orderBy(desc(agentMemory.confirmedByHuman), desc(agentMemory.confidence));

    const items: LearningItem[] = rows.map((r) => ({
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
    }));
    return { items };
  }

  /** Verifica que a lição é do agente/org e não está arquivada (404 amigável). Retorna a confiança atual. */
  async function requireLesson(orgId: OrgId, agentId: string, lessonId: string): Promise<{ confidence: number | null }> {
    const [row] = await deps.db
      .select({ confidence: agentMemory.confidence })
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
    return row;
  }

  /** Reescreve a frase do aprendizado (o usuário corrige com as próprias palavras). */
  async function edit(orgId: OrgId, agentId: string, lessonId: string, content: string): Promise<LearningOk> {
    await requireLesson(orgId, agentId, lessonId);
    await deps.db.update(agentMemory).set({ content, updatedAt: sql`now()` }).where(eq(agentMemory.id, lessonId));
    return { ok: true };
  }

  /** Confirma o aprendizado → marca `confirmedByHuman` + salto de confiança (só então pesa no prompt). */
  async function confirm(orgId: OrgId, agentId: string, lessonId: string): Promise<LearningOk> {
    const lesson = await requireLesson(orgId, agentId, lessonId);
    const confidence = computeConfidence(lesson.confidence, { type: "confirm" });
    await deps.db
      .update(agentMemory)
      .set({ confirmedByHuman: true, confidence, updatedAt: sql`now()` })
      .where(eq(agentMemory.id, lessonId));
    return { ok: true };
  }

  /** Esquece o aprendizado → soft-archive (nunca hard-delete; preserva trilha). */
  async function forget(orgId: OrgId, agentId: string, lessonId: string): Promise<LearningOk> {
    await requireLesson(orgId, agentId, lessonId);
    await deps.db.update(agentMemory).set({ lifecycle: "archived", updatedAt: sql`now()` }).where(eq(agentMemory.id, lessonId));
    return { ok: true };
  }

  return { list, edit, confirm, forget };
}
