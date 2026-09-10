// Infra COMPARTILHADA de foco de conta (usada pelo pré-grafo em `turn.ts` E pela tool `set_focus`
// em tools.ts): carregar as contas focáveis (ativas, com o agente ativo quando houver) e persistir
// o foco do fio. O MATCH nome→conta em si é o `resolveFocusMatch` puro (tools.ts / @trafego/core) —
// aqui só o IO (queries). Módulo neutro p/ não criar ciclo (turn.ts → tools.ts já existe).

import { and, eq } from "drizzle-orm";
import { adAccounts, agents, conversations, type Database } from "@trafego/db";
import { normalizeName, resolveNamedMatch, type NamedMatch } from "@trafego/core";

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

/** ms por hora — staleness do foco (S4). */
const MS_PER_HOUR = 60 * 60 * 1000;

/**
 * Agentes ativos da org (cap 2 p/ decidir sole × multi-conta). `sole` = exatamente 1;
 * `multiAccount` = ≥2 (concierge/foco). Nome da conta vem junto (eco/foco). Fonte única
 * (turn.ts pré-grafo E resolução de conta p/ salvar criativo — account-focus.ts).
 */
export async function resolveActiveAgents(
  db: Database,
  orgId: string,
): Promise<{ sole: AgentInContext | null; multiAccount: boolean }> {
  const rows = await db
    .select({ agentId: agents.id, adAccountId: agents.adAccountId, accountName: adAccounts.name })
    .from(agents)
    .innerJoin(adAccounts, eq(agents.adAccountId, adAccounts.id))
    .where(and(eq(agents.orgId, orgId), eq(agents.status, "active"), eq(adAccounts.status, "active")))
    .limit(2);
  return { sole: rows.length === 1 ? rows[0]! : null, multiAccount: rows.length >= 2 };
}

/**
 * Agente da conta em FOCO do fio (5c-6) — org-scoped, conta+agente ativos. Null se sem foco/
 * indisponível. **Staleness (S4, semântica de ÚLTIMO USO):** foco sem carimbo ou cujo último
 * uso passou de `ttlHours` PERDE precedência (retorna null → grupo cai no contexto ambiente,
 * DM cai em "qual conta?"). Ao resolver via foco fresco, RENOVA o carimbo (`focusedAt=now`).
 */
export async function resolveFocusedAgent(
  db: Database,
  orgId: string,
  conversationId: string,
  ttlHours: number,
): Promise<AgentInContext | null> {
  const [conv] = await db
    .select({ focusedAccountId: conversations.focusedAccountId, focusedAt: conversations.focusedAt })
    .from(conversations)
    .where(eq(conversations.id, conversationId))
    .limit(1);
  if (!conv?.focusedAccountId) return null;
  const staleBefore = Date.now() - ttlHours * MS_PER_HOUR;
  if (!conv.focusedAt || conv.focusedAt.getTime() < staleBefore) return null;
  const [row] = await db
    .select({ agentId: agents.id, adAccountId: agents.adAccountId, accountName: adAccounts.name })
    .from(agents)
    .innerJoin(adAccounts, eq(agents.adAccountId, adAccounts.id))
    .where(
      and(
        eq(agents.orgId, orgId),
        eq(agents.status, "active"),
        eq(adAccounts.status, "active"),
        eq(adAccounts.id, conv.focusedAccountId),
      ),
    )
    .limit(1);
  if (!row) return null;
  // último uso: renova o carimbo (o TTL conta desde a última atividade com foco).
  await db
    .update(conversations)
    .set({ focusedAt: new Date() })
    .where(and(eq(conversations.id, conversationId), eq(conversations.orgId, orgId)));
  return row;
}

/** Foco de conta = `resolveNamedMatch` sobre as candidatas (match exato pelo id externo cru
 *  `adAccountId` OU nome normalizado; senão Dice+contenção com folga). Fino sobre o core (a
 *  LÓGICA de match vive em `resolveNamedMatch`, fonte única; isto é só o plumbing das opções —
 *  espelha o `resolveFocusMatch` da tool `set_focus`, mesmo core). Interno ao módulo. */
function resolveFocusMatch(rows: readonly ActiveFocusCandidate[], query: string): NamedMatch<ActiveFocusCandidate> {
  return resolveNamedMatch(rows, query, { name: (r) => r.name, keys: (r) => [r.adAccountId] });
}

/**
 * Foco por MENÇÃO EXPLÍCITA na mensagem (S6b) — 3ª via, só quando NÃO há conta única nem foco
 * salvo. Resolve a conta nomeada no próprio texto ("...da conta Automato"). SÓ o caso `one`
 * (inequívoco) foca; `ambiguous`/`none` → null (o chamador pergunta qual conta). Persiste o foco
 * (igual ao `set_focus`) — o turno de confirmação ("sim") depende do foco salvo. Fonte única
 * (turn.ts pré-grafo E resolução de conta p/ salvar criativo).
 */
export async function resolveExplicitFocus(
  db: Database,
  orgId: string,
  conversationId: string,
  text: string,
): Promise<AgentInContext | null> {
  const candidates = await loadActiveFocusCandidates(db, orgId);
  if (candidates.length === 0) return null;
  const match = resolveFocusMatch(candidates, text);
  if (match.kind !== "one") return null; // ambíguo/inexistente → pede a conta (trava preservada)
  const picked = candidates.find((c) => c.id === match.row.id);
  if (!picked?.agentId) return null; // conta ativa sem agente ativo → não dá pra operar nela
  // sinal fraco (nome curto de palavra comum coincidindo com a frase) → defere (não foca a conta errada).
  if (!isDeliberateAccountReference(picked, text)) return null;
  await persistFocus(db, orgId, conversationId, picked.id);
  return { agentId: picked.agentId, adAccountId: picked.id, accountName: picked.name };
}

/**
 * Conta em CONTEXTO INEQUÍVOCA do fio — a MESMA régua de 3 níveis do `turn.ts inContext`
 * (fonte única): única conta ativa (`sole`) → foco FRESCO (dentro do TTL) → conta NOMEADA no
 * texto. NUNCA o foco cru/velho. Null = ambíguo → o chamador PERGUNTA a conta em vez de chutar.
 * Usada tanto pelo turno (responder) quanto pelo intake de criativo (salvar) — as duas superfícies
 * resolvem a MESMA conta, sem divergência (fim do bug de salvar na conta errada e de o Roy
 * confirmar um "guardei" numa conta em que nada foi salvo). `text` = "" quando não há texto.
 */
export async function resolveContextAccount(
  db: Database,
  orgId: string,
  conversationId: string,
  text: string,
  ttlHours: number,
): Promise<AgentInContext | null> {
  const { sole } = await resolveActiveAgents(db, orgId);
  if (sole) return sole;
  const focused = await resolveFocusedAgent(db, orgId, conversationId, ttlHours);
  if (focused) return focused;
  return resolveExplicitFocus(db, orgId, conversationId, text);
}

/** Só o UUID da conta em contexto (ad_accounts.id) ou null — açúcar sobre `resolveContextAccount`. */
export async function resolveContextAccountId(
  db: Database,
  orgId: string,
  conversationId: string,
  text: string,
  ttlHours: number,
): Promise<string | null> {
  return (await resolveContextAccount(db, orgId, conversationId, text, ttlHours))?.adAccountId ?? null;
}
