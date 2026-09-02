import { and, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { agentMemory, agents, type Database } from "@trafego/db";
import { confidenceTier } from "@trafego/core";
import type { OrgId } from "@trafego/shared/types";
import { notFound } from "../../middleware/error-handler.js";
import type { LearningItem, LearningsList } from "./schema.js";

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
      kind: r.type === "past_action" ? "calibration" : "fact",
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

  return { list };
}
