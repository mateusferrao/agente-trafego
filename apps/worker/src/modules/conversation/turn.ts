// Um turno do chat do WhatsApp (Grafo B): resolve o agente em contexto (1 ativo →
// conta; N/0 → concierge), roda o ReAct (checkpointer por conversa) e responde via
// sendToConversation (DM ou grupo). Reusado pelo flush do debounce (5b-2.4). Erro →
// resposta amigável. Grupo é aditivo: mesmo concierge/foco/tools da DM (§9/§13
// reuso-primeiro), só a origem (`ref`) e o destino de entrega mudam.

import { and, eq } from "drizzle-orm";
import type { Logger } from "pino";
import { HumanMessage, type AIMessage } from "@langchain/core/messages";
import { agents, loadOrgTimezone, type Database } from "@trafego/db";
import type { AutonomyPolicy, ConversationRef } from "@trafego/shared";
import type { WorkerDeps } from "../../composition.js";
import { buildWhatsappConversationGraph } from "../../graphs/whatsapp-conversation/graph.js";
import {
  AGENT_TOOL_NAMES,
  EDIT_AUDIENCE_TOOL_NAME,
  REALLOCATE_TOOL_NAME,
  REFINE_TOOL_NAMES,
  CONCIERGE_TOOL_NAMES,
  CONFIG_CHAT_TOOL_NAMES,
  GROUP_CONCIERGE_TOOL_NAMES,
  WRITE_TOOL_NAMES,
  type ConversationToolContext,
} from "../../graphs/whatsapp-conversation/tools.js";
import { loadEnabledTools } from "../tools/enabled.js";
import { resolveActiveAgents, resolveExplicitFocus, resolveFocusedAgent, type AgentInContext } from "./account-focus.js";
import { createNotifyRepo } from "../notify/repo.js";
import { createSendToConversation, type SendToConversation } from "../notify/send-to-contact.js";
import { applyOfferedCreative } from "./draft-proposal.js";
import { clearCreativeOffer, getCreativeOffer, isSimpleAffirmation } from "./creative-offer.js";
import { takePendingMedia, type PendingTurnMedia } from "./pending-media.js";
import { DEFAULT_CURRENCY, withTimeout } from "@trafego/shared";

/** Monta o HumanMessage do turno: multimodal (texto + imagem) quando há mídia-como-pergunta (B3),
 *  senão texto puro. `image_url` com data-url — o modelo do chat (multimodal) "vê" a imagem. */
function buildTurnMessage(text: string, media: PendingTurnMedia | null): HumanMessage {
  if (!media) return new HumanMessage(text);
  return new HumanMessage({
    content: [
      { type: "text", text },
      { type: "image_url", image_url: { url: media.dataUrl } },
    ],
  });
}

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
  // copiar campanha (Fatia 7) reusa o mesmo gate de criação (gasto novo, mesma saga).
  if (enabled.has("create_campaign")) tools.push("copy_campaign");
  if (enabled.has("duplicate_scale") || enabled.has("adjust_budget")) tools.push("scale_winner");
  // A1: editar público de adset vivo — opt-in, gated pelo binding `adjust_audience` (default OFF).
  if (enabled.has("adjust_audience")) tools.push(EDIT_AUDIENCE_TOOL_NAME);
  // A4: realocar orçamento A→B — vira 2 adjust_budget, então gated pelo mesmo binding `adjust_budget`.
  if (enabled.has("adjust_budget")) tools.push(REALLOCATE_TOOL_NAME);
  return tools;
}

/**
 * Allowlist do turno COM agente em contexto (5b-2). Base sempre-ligada (leitura + approve/reject +
 * revert + confirm/cancel) ∪ config ∪ (escrita/refino SÓ com `chatAdsWrites`). v1 (kill-switch de
 * plataforma): escrita conversacional OFF → NENHUMA tool de escrita Meta/refino entra (autoria/
 * edição/ação vivem na plataforma). Puro/testável — a fonte da flag (env→deps) fica na casca.
 */
export function buildInContextAllow(opts: {
  readonly writeTools: readonly string[];
  readonly configTools: readonly string[];
  readonly chatAdsWrites: boolean;
}): Set<string> {
  return new Set<string>([
    ...AGENT_TOOL_NAMES,
    ...(opts.chatAdsWrites ? opts.writeTools : []),
    ...(opts.chatAdsWrites ? REFINE_TOOL_NAMES : []),
    ...opts.configTools,
  ]);
}

/**
 * Concierge de GRUPO (S6) + fix same-turn: além dos reads always-bind e do set_focus, binda as
 * tools de config. Assim "foca na Loja X e liga o aviso" resolve no MESMO papo — o set_focus muta o
 * ctx (agentId/adAccountId) e a tool de config já opera na conta focada; sem foco, o gate de config
 * pede pra focar (guard em confirmWriteGate). Bindar aqui NÃO afrouxa segurança: o kill-switch
 * `autoConfigViaChat` segue barrado no APPLY (applyConfirmedConfig re-lê fresco e aborta se OFF).
 */
export const GROUP_CONCIERGE_ALLOW: ReadonlySet<string> = new Set<string>([
  ...GROUP_CONCIERGE_TOOL_NAMES,
  ...CONFIG_CHAT_TOOL_NAMES,
]);

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
  // B3: imagem-com-legenda anexada a ESTE turno (multimodal) — consumida uma vez (get+del).
  const attachedMedia = await takePendingMedia(deps.redis, input.conversationId);

  // agente em contexto = a única conta ativa (sole) OU a conta em foco do fio (multi-conta,
  // 5c-6). Sem nenhuma das duas → concierge (só org-level + set_focus p/ escolher). Igual
  // no grupo: mesmo concierge/foco, escopo = todas as contas da org (§13 reuso-primeiro).
  const { sole, multiAccount } = await resolveActiveAgents(deps.db, input.orgId);
  // 1) conta única → ela; 2) foco salvo do fio; 3) conta NOMEADA de forma inequívoca na mensagem
  // (S6b — resolve o foco antes de montar o toolset, pra a escrita ligar no mesmo fluxo). O (3) só
  // roda quando não há (1) nem (2); ambíguo/inexistente → null → concierge pergunta a conta.
  let inContext =
    sole ?? (await resolveFocusedAgent(deps.db, input.orgId, input.conversationId, deps.conversation.focusTtlHours));
  if (!inContext) inContext = await resolveExplicitFocus(deps.db, input.orgId, input.conversationId, input.text);

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
    // escrita conversacional de ads (v1: default OFF) — molda toolset + prompt + capacidades.
    chatAdsWrites: deps.conversation.chatAdsWrites,
    ...(inContext?.accountName ? { accountName: inContext.accountName } : {}),
    // B3: mídia anexada ao turno → injeta o kernel de criativo no prompt + habilita a tool de
    // análise estruturada sobre a imagem (o modelo já a vê no HumanMessage multimodal).
    ...(attachedMedia ? { attachedMedia } : {}),
  };
  // sem agente em contexto: concierge. Em GRUPO multi-conta, always-bind de LEITURA (S6) →
  // a 1ª pergunta resolve num turno (set_focus muta o ctx; reads self-guardam sem foco).
  const conciergeAllow =
    input.ref.kind === "group" && multiAccount ? GROUP_CONCIERGE_ALLOW : CONCIERGE_TOOL_NAMES;
  // escrita + criação resolvidas da MESMA fonte (bindings) que o apply usa (A2). Criação
  // desligada nos bindings → tool fora do toolset (recusa honesta), sem re-checar no apply.
  // v1 (kill-switch de plataforma): escrita conversacional de ads OFF → NENHUMA tool de escrita/
  // criação/refino entra no toolset (autoria/edição/ação vivem na plataforma). Consulta +
  // approve/reject + revert + config seguem (vêm de AGENT_TOOL_NAMES/config, não daqui).
  const chatAdsWrites = deps.conversation.chatAdsWrites;
  const writeTools = inContext && chatAdsWrites ? await allowedChatWriteTools(deps.db, input.orgId, inContext.agentId) : [];
  const allow = inContext
    ? buildInContextAllow({ writeTools, configTools: config.tools, chatAdsWrites })
    : conciergeAllow;

  // Slice 7 (ponte estado→turno): o usuário mandou um criativo no WhatsApp (o intake guardou uma
  // OFERTA no Redis) e agora respondeu. Só um "sim" CLARO resolve — usar o criativo no rascunho
  // pendente ou criar uma campanha com ele — ANTES do grafo. Ambíguo/composto → segue pro turno
  // normal (a oferta fica no TTL; o usuário pode confirmar depois). Precisa de agente em contexto.
  // v1 (kill-switch): usar o criativo enviado = autoria/edição de campanha por chat → só com
  // chatAdsWrites ON. OFF → o intake nem guarda oferta (media-intake); a imagem fica na biblioteca
  // pro usuário usar num rascunho no site.
  if (inContext && chatAdsWrites) {
    const offer = await getCreativeOffer(deps.redis, input.conversationId);
    if (offer && isSimpleAffirmation(input.text)) {
      try {
        const offerReply = await applyOfferedCreative(
          deps,
          { orgId: input.orgId, agentId: inContext.agentId, adAccountId: inContext.adAccountId, currency: DEFAULT_CURRENCY },
          offer,
        );
        // limpa a oferta só APÓS o sucesso: se applyOfferedCreative falhar (Meta/LLM), a oferta
        // fica no TTL e o usuário pode tentar de novo — sem sumir silenciosamente.
        await clearCreativeOffer(deps.redis, input.conversationId);
        await deliverReply(sendToConversation, input.ref, offerReply, logger, input.orgId);
      } catch (err) {
        logger.error({ err, orgId: input.orgId }, "conversation:oferta de criativo falhou");
        await deliverReply(sendToConversation, input.ref, FALLBACK_REPLY, logger, input.orgId);
      }
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
          messages: [buildTurnMessage(input.text, attachedMedia)],
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
