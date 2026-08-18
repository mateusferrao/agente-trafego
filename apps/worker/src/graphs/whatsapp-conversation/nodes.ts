// Nós do grafo `whatsapp-conversation` (ReAct-style): agent (LLM+tools) ↔ tools,
// com um gate de confirmação humana antes de qualquer ESCRITA.

import { ToolNode } from "@langchain/langgraph/prebuilt";
import { AIMessage } from "@langchain/core/messages";
import type { WorkerDeps } from "../../composition.js";
import type {
  WhatsappConversationStateType,
  WhatsappConversationUpdate,
} from "./state.js";
import { WRITE_TOOL_NAMES, makeConversationTools, type ConversationToolContext } from "./tools.js";

export function makeConversationNodes(deps: WorkerDeps) {
  const { logger } = deps;

  /** Nó ReAct: chama o LLM (via OpenRouter) com as tools da allowlist. */
  async function agent(state: WhatsappConversationStateType): Promise<WhatsappConversationUpdate> {
    logger.debug({ contactId: state.contactId }, "conversation:agent");
    // TODO: resolver allowlist (agent_tool_bindings) + montar model (LLMProviderPort/ChatOpenAI-OpenRouter)
    //       bindTools(tools) + system_prompt/persona do agente.
    // TODO: se existe pendingApprovalId → instruir o modelo a mapear a fala em aprovar/rejeitar ações.
    // const response = await model.invoke(state.messages);
    // return { messages: [response] };
    return { messages: [new AIMessage("TODO: resposta do agente")] };
  }

  /** Executa APENAS tools de leitura já confirmadas. As de escrita passam pelo gate. */
  function toolsNode(ctx: ConversationToolContext, allow: ReadonlySet<string>) {
    const tools = makeConversationTools(deps, ctx, allow);
    // TODO: ToolNode roda a tool escolhida pelo modelo. Para tools de proposta
    //       (escrita), o retorno é o ECO — não a mutação.
    return new ToolNode(tools);
  }

  /**
   * Gate de confirmação: antes de QUALQUER escrita, exige eco concreto +
   * confirmação explícita do humano (CLAUDE §8). Ambiguidade → pergunta,
   * nunca aplica em interpretação incerta.
   */
  async function confirmWriteGate(
    state: WhatsappConversationStateType,
  ): Promise<WhatsappConversationUpdate> {
    logger.debug({ contactId: state.contactId }, "conversation:confirm_write_gate");
    // TODO: se o último turno humano confirma (sim explícito) um pendingWrite →
    //       liberar execução real via executors/meta-tools (guardrail de novo) e
    //       registrar agent_tool_calls(idempotency_key, before_state).
    // TODO: senão, se o modelo propôs uma tool de escrita → setar pendingWrite (eco) e responder.
    return {};
  }

  return { agent, toolsNode, confirmWriteGate };
}

/**
 * Roteamento ReAct pós-agent:
 * - tool call de LEITURA → "tools"
 * - tool call de ESCRITA → "confirm" (eco+confirma antes de executar)
 * - sem tool call → END (responde ao usuário)
 */
export function routeConversation(
  state: WhatsappConversationStateType,
): "tools" | "confirm" | "__end__" {
  const last = state.messages.at(-1);
  const toolCalls = (last as AIMessage | undefined)?.tool_calls ?? [];
  if (toolCalls.length === 0) return "__end__";
  const hasWrite = toolCalls.some((c) => WRITE_TOOL_NAMES.has(c.name));
  return hasWrite ? "confirm" : "tools";
}
