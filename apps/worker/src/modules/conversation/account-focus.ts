// Infra COMPARTILHADA de foco de conta (usada pelo pré-grafo em `turn.ts` E pela tool `set_focus`
// em tools.ts): carregar as contas focáveis (ativas, com o agente ativo quando houver) e persistir
// o foco do fio. O MATCH nome→conta em si é o `resolveFocusMatch` puro (tools.ts / @trafego/core) —
// aqui só o IO (queries). Módulo neutro p/ não criar ciclo (turn.ts → tools.ts já existe).

import { and, eq } from "drizzle-orm";
import { adAccounts, agents, conversations, type Database } from "@trafego/db";
import { normalizeName } from "@trafego/core";

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

/**
 * Comprimento mínimo do nome de palavra ÚNICA p/ aceitar o foco por menção explícita sobre a FRASE
 * inteira. O match de foco casa por CONTENÇÃO (nome ⊂ frase) — ótimo quando o usuário digita o nome,
 * mas sobre a frase toda um nome curto de palavra comum ("Lead", "Loja", "Vendas") coincidiria com uma
 * palavra qualquer e focaria a conta errada. Nomes curtos de palavra única deferem pro `set_focus`
 * (o LLM extrai o nome limpo) — sem regressão, só sem o atalho determinístico.
 */
const MIN_SINGLE_TOKEN_FOCUS_NAME_LEN = 7;

/**
 * A conta foi referida de forma DELIBERADA na frase? (pré-grafo, S6b). Sinal forte o bastante p/ focar
 * automaticamente sobre a frase inteira: (1) o id externo da conta aparece no texto; (2) o nome é
 * MULTI-palavra (contenção de 2+ tokens específicos raramente é acaso); ou (3) nome de palavra única
 * distintivo (≥ `MIN_SINGLE_TOKEN_FOCUS_NAME_LEN`). Senão → defere pro `set_focus` (LLM). PURO/testável.
 */
export function isDeliberateAccountReference(candidate: Pick<ActiveFocusCandidate, "name" | "adAccountId">, text: string): boolean {
  if (candidate.adAccountId && text.toLowerCase().includes(candidate.adAccountId.toLowerCase())) return true;
  const normName = normalizeName(candidate.name ?? "");
  if (!normName) return false;
  const tokens = normName.split(/\s+/).filter(Boolean);
  if (tokens.length >= 2) return true;
  return normName.length >= MIN_SINGLE_TOKEN_FOCUS_NAME_LEN;
}

/** Persiste a conta em foco do fio (`conversations.focused_account_id` + carimbo de uso). Fonte
 *  única do write de foco — usada pelo `set_focus` e pela resolução explícita pré-grafo. */
export async function persistFocus(db: Database, orgId: string, conversationId: string, adAccountId: string): Promise<void> {
  await db
    .update(conversations)
    .set({ focusedAccountId: adAccountId, focusedAt: new Date() })
    .where(and(eq(conversations.id, conversationId), eq(conversations.orgId, orgId)));
}
