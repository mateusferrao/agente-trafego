// Um turno do chat do WhatsApp (Grafo B): resolve o agente em contexto (1 ativo →
// conta; N/0 → concierge), roda o ReAct (checkpointer por conversa) e responde via
// sendToContact. Reusado pelo flush do debounce (5b-2.4). Erro → resposta amigável.

import { and, eq } from "drizzle-orm";
import { HumanMessage, type AIMessage } from "@langchain/core/messages";
import { adAccounts, agents, conversations, guardrailConfigs, type Database } from "@trafego/db";
import type { ActionType, AutonomyPolicy } from "@trafego/shared";
import type { WorkerDeps } from "../../composition.js";
import { buildWhatsappConversationGraph } from "../../graphs/whatsapp-conversation/graph.js";
import {
  AGENT_TOOL_NAMES,
  CONCIERGE_TOOL_NAMES,
  CONFIG_CHAT_TOOL_NAMES,
  WRITE_TOOL_TO_ACTION,
  type ConversationToolContext,
} from "../../graphs/whatsapp-conversation/tools.js";
import { createNotifyRepo } from "../notify/repo.js";
import { createSendToContact } from "../notify/send-to-contact.js";

/** Erro amigável se o turno falhar (LLM/infra) — nunca vaza stack pro usuário (§UX). */
const FALLBACK_REPLY = "Não consegui processar agora. Tenta de novo em instantes.";

/** Agente em contexto (id + conta + nome da conta). */
interface AgentInContext {
  readonly agentId: string;
  readonly adAccountId: string;
  readonly accountName: string | null;
}

/**
 * Agentes ativos da org (cap 2 p/ decidir sole × multi-conta). `sole` = exatamente 1;
 * `multiAccount` = ≥2 (concierge/foco). Nome da conta vem junto (eco/foco).
 */
async function resolveActiveAgents(
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

/** Agente da conta em FOCO do fio (5c-6) — org-scoped, conta+agente ativos. Null se sem foco/indisponível. */
async function resolveFocusedAgent(
  db: Database,
  orgId: string,
  conversationId: string,
): Promise<AgentInContext | null> {
  const [conv] = await db
    .select({ focusedAccountId: conversations.focusedAccountId })
    .from(conversations)
    .where(eq(conversations.id, conversationId))
    .limit(1);
  if (!conv?.focusedAccountId) return null;
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
  return row ?? null;
}

/**
 * Nomes das tools de ESCRITA livre habilitadas p/ o agente = as cujo tipo de ação está em
 * `allowedActions` (guardrail). É o "enforcement" do chat (5c): tool não permitida nem chega
 * ao LLM → recusa honesta na hora. O guardrail re-checa no apply como 2ª rede.
 */
async function allowedWriteTools(db: Database, orgId: string, agentId: string): Promise<string[]> {
  const [row] = await db
    .select({ allowedActions: guardrailConfigs.allowedActions })
    .from(guardrailConfigs)
    .where(and(eq(guardrailConfigs.agentId, agentId), eq(guardrailConfigs.orgId, orgId)))
    .limit(1);
  const allowed = new Set<ActionType>((row?.allowedActions ?? []) as ActionType[]);
  return [...WRITE_TOOL_TO_ACTION.entries()].filter(([, action]) => allowed.has(action)).map(([tool]) => tool);
}

/**
 * Kill-switch da auto-config por chat (S2.3): a config só entra na allowlist quando
 * `autonomy_policy.autoConfigViaChat !== false` (ausente/true = ON; default). Desligado
 * → as tools de config NEM CHEGAM ao LLM (config passa a ser pelo site). NÃO passam por
 * `allowedActions` (isso é só escrita Meta). Retorna também o flag p/ moldar o prompt.
 */
export async function configToolsFor(
  db: Database,
  orgId: string,
  agentId: string,
): Promise<{ tools: string[]; enabled: boolean }> {
  const [row] = await db
    .select({ autonomyPolicy: agents.autonomyPolicy })
    .from(agents)
    .where(and(eq(agents.id, agentId), eq(agents.orgId, orgId)))
    .limit(1);
  const policy = row?.autonomyPolicy as AutonomyPolicy | undefined;
  const enabled = policy?.autoConfigViaChat !== false;
  return { tools: enabled ? [...CONFIG_CHAT_TOOL_NAMES] : [], enabled };
}

export interface ConversationTurnInput {
  readonly orgId: string;
  readonly contactId: string;
  readonly conversationId: string;
  /** texto do turno (uma ou mais mensagens coalescidas pelo debounce). */
  readonly text: string;
}

/** Roda o Grafo B para um turno e empurra a resposta na conversa. */
export async function runConversationTurn(deps: WorkerDeps, input: ConversationTurnInput): Promise<void> {
  const { logger, ports } = deps;
  const sendToContact = createSendToContact({ messaging: ports.messaging, repo: createNotifyRepo(deps.db) });

  // agente em contexto = a única conta ativa (sole) OU a conta em foco do fio (multi-conta,
  // 5c-6). Sem nenhuma das duas → concierge (só org-level + set_focus p/ escolher).
  const { sole, multiAccount } = await resolveActiveAgents(deps.db, input.orgId);
  const inContext = sole ?? (await resolveFocusedAgent(deps.db, input.orgId, input.conversationId));

  // com agente em contexto: leitura/controle + escrita livre filtrada por allowedActions (5c)
  // + config-por-chat gated pelo kill-switch (S2.3). Sem contexto (multi-conta sem foco):
  // concierge — org-level + set_focus.
  const config = inContext ? await configToolsFor(deps.db, input.orgId, inContext.agentId) : { tools: [], enabled: false };

  const ctx: ConversationToolContext = {
    orgId: input.orgId,
    agentId: inContext?.agentId ?? "",
    adAccountId: inContext?.adAccountId ?? "",
    contactId: input.contactId,
    conversationId: input.conversationId,
    multiAccount,
    // config-por-chat ligada? (molda o system-prompt: por chat × pelo site).
    configViaChat: config.enabled,
    ...(inContext?.accountName ? { accountName: inContext.accountName } : {}),
  };
  const allow = inContext
    ? new Set<string>([
        ...AGENT_TOOL_NAMES,
        ...(await allowedWriteTools(deps.db, input.orgId, inContext.agentId)),
        ...config.tools,
      ])
    : CONCIERGE_TOOL_NAMES;

  let reply = FALLBACK_REPLY;
  try {
    const graph = buildWhatsappConversationGraph(deps, ctx, allow);
    const result = await graph.invoke(
      {
        messages: [new HumanMessage(input.text)],
        orgId: ctx.orgId,
        agentId: ctx.agentId,
        adAccountId: ctx.adAccountId,
        contactId: ctx.contactId,
      },
      { configurable: { thread_id: input.conversationId } },
    );
    const last = result.messages.at(-1) as AIMessage | undefined;
    const text = typeof last?.content === "string" ? last.content.trim() : "";
    if (text.length > 0) reply = text;
  } catch (err) {
    logger.error({ err, orgId: input.orgId }, "conversation:turn falhou");
  }

  await sendToContact(input.contactId, reply, { split: true });
  logger.info({ orgId: input.orgId }, "conversation:replied");
}
