// Infra COMPARTILHADA de foco de conta (usada pelo pré-grafo em `turn.ts` E pela tool `set_focus`
// em tools.ts): carregar as contas focáveis (ativas, com o agente ativo quando houver) e persistir
// o foco do fio. O MATCH nome→conta em si é o `resolveFocusMatch` puro (tools.ts / @trafego/core) —
// aqui só o IO (queries). Módulo neutro p/ não criar ciclo (turn.ts → tools.ts já existe).

import { and, eq } from "drizzle-orm";
import { adAccounts, agents, conversations, type Database } from "@trafego/db";

/** Agente em contexto (id + conta + nome da conta) — o "quem opera" resolvido do turno. */
export interface AgentInContext {
  readonly agentId: string;
  readonly adAccountId: string;
  readonly accountName: string | null;
}

/** Conta focável: linha de `ad_accounts` (p/ o match) + o agente ativo dela (null se não tiver). */
export interface ActiveFocusCandidate {
  readonly id: string;
  readonly name: string | null;
  readonly adAccountId: string;
  /** agente ATIVO da conta (null → conta ativa sem agente: não dá pra operar nela). */
  readonly agentId: string | null;
}

/**
 * Contas ativas da org como candidatas de foco, cada uma já com o `agentId` do seu agente ativo
 * (LEFT JOIN → conta sem agente ativo entra com `agentId=null`, preservando a semântica do
 * `set_focus` de "achei a conta, mas ela não tem agente ativo"). Dedupe defensivo por conta
 * (MVP é 1 agente:1 conta; se houver >1 ativo, fica o 1º). `orderBy(name)` = desempate estável.
 */
export async function loadActiveFocusCandidates(db: Database, orgId: string): Promise<readonly ActiveFocusCandidate[]> {
  const rows = await db
    .select({ id: adAccounts.id, name: adAccounts.name, adAccountId: adAccounts.adAccountId, agentId: agents.id })
    .from(adAccounts)
    .leftJoin(agents, and(eq(agents.adAccountId, adAccounts.id), eq(agents.status, "active")))
    .where(and(eq(adAccounts.orgId, orgId), eq(adAccounts.status, "active")))
    .orderBy(adAccounts.name);
  const byId = new Map<string, ActiveFocusCandidate>();
  for (const r of rows) if (!byId.has(r.id)) byId.set(r.id, r);
  return [...byId.values()];
}

/** Persiste a conta em foco do fio (`conversations.focused_account_id` + carimbo de uso). Fonte
 *  única do write de foco — usada pelo `set_focus` e pela resolução explícita pré-grafo. */
export async function persistFocus(db: Database, orgId: string, conversationId: string, adAccountId: string): Promise<void> {
  await db
    .update(conversations)
    .set({ focusedAccountId: adAccountId, focusedAt: new Date() })
    .where(and(eq(conversations.id, conversationId), eq(conversations.orgId, orgId)));
}
