// Um turno do chat do WhatsApp (Grafo B): resolve o agente em contexto (1 ativo →
// conta; N/0 → concierge), roda o ReAct (checkpointer por conversa) e responde via
// sendToConversation (DM ou grupo). Reusado pelo flush do debounce (5b-2.4). Erro →
// resposta amigável. Grupo é aditivo: mesmo concierge/foco/tools da DM (§9/§13
// reuso-primeiro), só a origem (`ref`) e o destino de entrega mudam.

import { and, eq } from "drizzle-orm";
import type { Logger } from "pino";
import { HumanMessage, type AIMessage } from "@langchain/core/messages";
import { adAccounts, agents, conversations, loadOrgTimezone, type Database } from "@trafego/db";
import type { AutonomyPolicy, ConversationRef } from "@trafego/shared";
import type { WorkerDeps } from "../../composition.js";
import { buildWhatsappConversationGraph } from "../../graphs/whatsapp-conversation/graph.js";
import {
  AGENT_TOOL_NAMES,
  REFINE_TOOL_NAMES,
  CONCIERGE_TOOL_NAMES,
  CONFIG_CHAT_TOOL_NAMES,
  GROUP_CONCIERGE_TOOL_NAMES,
  WRITE_TOOL_NAMES,
  type ConversationToolContext,
} from "../../graphs/whatsapp-conversation/tools.js";
import { loadEnabledTools } from "../tools/enabled.js";
import { createNotifyRepo } from "../notify/repo.js";
import { createSendToConversation, type SendToConversation } from "../notify/send-to-contact.js";
import { withTimeout } from "./with-timeout.js";
import { applyOfferedCreative } from "./draft-proposal.js";
import { clearCreativeOffer, getCreativeOffer, isSimpleAffirmation } from "./creative-offer.js";
import { DEFAULT_CURRENCY } from "@trafego/shared";

/** Erro amigável se o turno falhar (LLM/infra) — nunca vaza stack pro usuário (§UX). */
const FALLBACK_REPLY = "Não consegui processar agora. Tenta de novo em instantes.";

/**
 * Entrega a resposta à conversa (DM ou grupo) de forma RESILIENTE: uma falha de envio
 * (Evolution fora) NÃO propaga. O turno já foi computado (LLM já gasto) — relançar
 * faria o BullMQ re-invocar o grafo e re-gastar tokens. Melhor perder o envio (logado)
 * do que recomputar. Reenvio idempotente = fast-follow.
 */
export async function deliverReply(
  sendToConversation: SendToConversation,
  ref: ConversationRef,
  reply: string,
  logger: Pick<Logger, "info" | "error">,
  orgId: string,
): Promise<void> {
  try {
    // quoteLastInbound: cita a última mensagem do usuário (no debounce, a última picada).
    await sendToConversation(ref, reply, { split: true, quoteLastInbound: true });
    logger.info({ orgId }, "conversation:replied");
  } catch (err) {
    logger.error({ err, orgId }, "conversation:send falhou (resposta perdida, sem retry do grafo)");
  }
}

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

/** ms por hora — staleness do foco (S4). */
const MS_PER_HOUR = 60 * 60 * 1000;

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

/**
 * Tools de ESCRITA/CRIAÇÃO habilitadas p/ o chat (A2) — AUTORITATIVO por `agent_tool_bindings`
 * (fallback = allowedActions p/ as 4, default-on p/ criação; ver `loadEnabledTools`). Tool não
 * habilitada nem chega ao LLM → recusa honesta. O apply re-checa da MESMA fonte (consistência).
 * Mapeamento tool-de-chat → binding: as 4 mutações têm nome == binding-key; `create_campaign` ↔
 * binding homônimo; `scale_winner` (faz raise OU duplicate) habilita se `duplicate_scale` OU
 * `adjust_budget` (o raise) estiver ligado.
 */
async function allowedChatWriteTools(db: Database, orgId: string, agentId: string): Promise<string[]> {
  const enabled = await loadEnabledTools(db, orgId, agentId);
  const tools: string[] = [];
  for (const t of WRITE_TOOL_NAMES) if (enabled.has(t)) tools.push(t);
  if (enabled.has("create_campaign")) tools.push("create_campaign");
  if (enabled.has("duplicate_scale") || enabled.has("adjust_budget")) tools.push("scale_winner");
  return tools;
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
  /** quem fala — DM (contato verificado) ou grupo (participante, sem verificação). */
  readonly ref: ConversationRef;
  readonly conversationId: string;
  /** texto do turno (uma ou mais mensagens coalescidas pelo debounce). */
  readonly text: string;
}

/** Roda o Grafo B para um turno e empurra a resposta na conversa (DM ou grupo). */
export async function runConversationTurn(deps: WorkerDeps, input: ConversationTurnInput): Promise<void> {
  const { logger, ports } = deps;
  const sendToConversation = createSendToConversation({ messaging: ports.messaging, repo: createNotifyRepo(deps.db) });

  // agente em contexto = a única conta ativa (sole) OU a conta em foco do fio (multi-conta,
  // 5c-6). Sem nenhuma das duas → concierge (só org-level + set_focus p/ escolher). Igual
  // no grupo: mesmo concierge/foco, escopo = todas as contas da org (§13 reuso-primeiro).
  const { sole, multiAccount } = await resolveActiveAgents(deps.db, input.orgId);
  const inContext =
    sole ?? (await resolveFocusedAgent(deps.db, input.orgId, input.conversationId, deps.conversation.focusTtlHours));

  // com agente em contexto: leitura/controle + escrita livre filtrada por allowedActions (5c)
  // + config-por-chat gated pelo kill-switch (S2.3). Sem contexto (multi-conta sem foco):
  // concierge — org-level + set_focus.
  const config = inContext ? await configToolsFor(deps.db, input.orgId, inContext.agentId) : { tools: [], enabled: false };
  const timezone = await loadOrgTimezone(deps.db, input.orgId, deps.cron.tz);

  const ctx: ConversationToolContext = {
    orgId: input.orgId,
    agentId: inContext?.agentId ?? "",
    adAccountId: inContext?.adAccountId ?? "",
    timezone,
    ref: input.ref,
    conversationId: input.conversationId,
    multiAccount,
    // config-por-chat ligada? (molda o system-prompt: por chat × pelo site).
    configViaChat: config.enabled,
    ...(inContext?.accountName ? { accountName: inContext.accountName } : {}),
  };
  // sem agente em contexto: concierge. Em GRUPO multi-conta, always-bind de LEITURA (S6) →
  // a 1ª pergunta resolve num turno (set_focus muta o ctx; reads self-guardam sem foco).
  const conciergeAllow =
    input.ref.kind === "group" && multiAccount ? GROUP_CONCIERGE_TOOL_NAMES : CONCIERGE_TOOL_NAMES;
  // escrita + criação resolvidas da MESMA fonte (bindings) que o apply usa (A2). Criação
  // desligada nos bindings → tool fora do toolset (recusa honesta), sem re-checar no apply.
  const writeTools = inContext ? await allowedChatWriteTools(deps.db, input.orgId, inContext.agentId) : [];
  const allow = inContext
    ? new Set<string>([...AGENT_TOOL_NAMES, ...writeTools, ...REFINE_TOOL_NAMES, ...config.tools])
    : conciergeAllow;

  // Slice 7 (ponte estado→turno): o usuário mandou um criativo no WhatsApp (o intake guardou uma
  // OFERTA no Redis) e agora respondeu. Só um "sim" CLARO resolve — usar o criativo no rascunho
  // pendente ou criar uma campanha com ele — ANTES do grafo. Ambíguo/composto → segue pro turno
  // normal (a oferta fica no TTL; o usuário pode confirmar depois). Precisa de agente em contexto.
  if (inContext) {
    const offer = await getCreativeOffer(deps.redis, input.conversationId);
    if (offer && isSimpleAffirmation(input.text)) {
      await clearCreativeOffer(deps.redis, input.conversationId);
      const offerReply = await applyOfferedCreative(
        deps,
        { orgId: input.orgId, agentId: inContext.agentId, adAccountId: inContext.adAccountId, currency: DEFAULT_CURRENCY },
        offer,
      );
      await deliverReply(sendToConversation, input.ref, offerReply, logger, input.orgId);
      return;
    }
  }

  let reply = FALLBACK_REPLY;
  try {
    const graph = buildWhatsappConversationGraph(deps, ctx, allow);
    // Teto de tempo do turno inteiro: qualquer travamento (Meta/LLM/DB presos sem dar
    // erro) não pode deixar o usuário sem resposta pra sempre — vira o fallback amigável.
    const result = await withTimeout(
      graph.invoke(
        {
          messages: [new HumanMessage(input.text)],
          orgId: ctx.orgId,
          agentId: ctx.agentId,
          adAccountId: ctx.adAccountId,
        },
        { configurable: { thread_id: input.conversationId } },
      ),
      deps.conversation.turnTimeoutMs,
    );
    const last = result.messages.at(-1) as AIMessage | undefined;
    const text = typeof last?.content === "string" ? last.content.trim() : "";
    if (text.length > 0) reply = text;
    else
      logger.error(
        { orgId: input.orgId, lastType: last?.getType?.(), toolCalls: last?.tool_calls?.length ?? 0 },
        "conversation:grafo terminou sem texto — usando fallback",
      );
  } catch (err) {
    logger.error({ err, orgId: input.orgId }, "conversation:turn falhou");
  }

  await deliverReply(sendToConversation, input.ref, reply, logger, input.orgId);
}
