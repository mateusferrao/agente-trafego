// Nós do grafo `whatsapp-conversation` (ReAct): agent (LLM+tools) ↔ tools, com um
// gate de confirmação humana antes de qualquer ESCRITA (5b-2.3). Na 5b-2.2 só há
// tools de LEITURA + trigger_analysis, então o gate fica inativo (nenhuma write tool).

import { ChatOpenAI } from "@langchain/openai";
import { AIMessage, SystemMessage } from "@langchain/core/messages";
import { ToolNode } from "@langchain/langgraph/prebuilt";
import type { WorkerDeps } from "../../composition.js";
import { loadConversationConfig } from "./system-prompt.js";
import { windowMessages } from "./window.js";
import {
  WRITE_TOOL_NAMES,
  makeConversationTools,
  type ConversationToolContext,
} from "./tools.js";
import type {
  WhatsappConversationStateType,
  WhatsappConversationUpdate,
} from "./state.js";

const CONVERSATION_TEMPERATURE = 0.3;

/** Extrai tokens/custo da resposta do ChatOpenAI (OpenRouter com usage.include). */
function usageOf(msg: AIMessage): { inputTokens?: number; outputTokens?: number; costUsd?: number } {
  const u = msg.usage_metadata;
  const meta = msg.response_metadata as Record<string, unknown> | undefined;
  const cost = (meta?.["usage"] as Record<string, unknown> | undefined)?.["cost"];
  return {
    ...(u?.input_tokens != null ? { inputTokens: u.input_tokens } : {}),
    ...(u?.output_tokens != null ? { outputTokens: u.output_tokens } : {}),
    ...(typeof cost === "number" ? { costUsd: cost } : {}),
  };
}

export function makeConversationNodes(
  deps: WorkerDeps,
  ctx: ConversationToolContext,
  allow: ReadonlySet<string>,
) {
  const { logger } = deps;
  const tools = makeConversationTools(deps, ctx, allow);

  /** Nó ReAct: LLM (OpenRouter) com as tools da allowlist + voz do agente. */
  async function agent(state: WhatsappConversationStateType): Promise<WhatsappConversationUpdate> {
    logger.debug({ contactId: ctx.contactId }, "conversation:agent");
    const { systemPrompt, model } = await loadConversationConfig(
      deps.db,
      ctx.orgId,
      ctx.agentId.length > 0 ? ctx.agentId : null,
      deps.conversation.model,
    );

    const chat = new ChatOpenAI({
      model,
      apiKey: deps.conversation.apiKey,
      configuration: { baseURL: deps.conversation.baseUrl },
      temperature: CONVERSATION_TEMPERATURE,
      // OpenRouter devolve custo real quando pedimos usage — essencial p/ o billing (§11).
      modelKwargs: { usage: { include: true } },
    }).bindTools(tools);

    // janela por turno + teto de tokens (nunca quebra par tool_call/tool_result).
    const windowed = windowMessages(state.messages, {
      maxTurns: deps.conversation.historyTurns,
      maxTokens: deps.conversation.maxTokens,
    });
    const response = (await chat.invoke([new SystemMessage(systemPrompt), ...windowed])) as AIMessage;

    // metering (§11): as chamadas do chat também entram no ledger de custo.
    try {
      await deps.ports.metering.record({
        orgId: ctx.orgId as never,
        type: "conversation",
        provider: "openrouter",
        model,
        ...usageOf(response),
        payload: { contactId: ctx.contactId },
      });
    } catch (err) {
      logger.warn({ err }, "conversation:metering falhou");
    }

    return { messages: [response] };
  }

  /** Executa as tools de leitura escolhidas pelo modelo (escrita passa pelo gate). */
  function toolsNode() {
    return new ToolNode(tools);
  }

  /**
   * Gate de confirmação antes de QUALQUER escrita (CLAUDE §8). Inativo na 5b-2.2
   * (sem write tools); implementado na 5b-2.3 (aprovação conversacional).
   */
  async function confirmWriteGate(): Promise<WhatsappConversationUpdate> {
    return {};
  }

  return { agent, toolsNode, confirmWriteGate };
}

/**
 * Roteamento ReAct pós-agent: tool de LEITURA → "tools"; tool de ESCRITA →
 * "confirm" (5b-2.3); sem tool call → END (responde ao usuário).
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
