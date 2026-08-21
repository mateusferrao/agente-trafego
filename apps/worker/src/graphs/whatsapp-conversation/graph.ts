// Grafo `whatsapp-conversation` (LangGraph StateGraph, laço ReAct).
// Chat aberto com allowlist de tools + guardrails + resolução de aprovação pendente.
// Regra dura: antes de QUALQUER escrita → eco concreto + confirma (CLAUDE §8).

import { END, START, StateGraph } from "@langchain/langgraph";
import type { WorkerDeps } from "../../composition.js";
import { makeConversationNodes, routeConversation } from "./nodes.js";
import { WhatsappConversationState } from "./state.js";
import type { ConversationToolContext } from "./tools.js";

export function buildWhatsappConversationGraph(
  deps: WorkerDeps,
  ctx: ConversationToolContext,
  allow: ReadonlySet<string>,
) {
  const n = makeConversationNodes(deps, ctx, allow);

  const workflow = new StateGraph(WhatsappConversationState)
    .addNode("agent", n.agent)
    .addNode("tools", n.toolsNode())
    .addNode("confirm", n.confirmWriteGate)
    .addNode("apply", n.applyWrite)
    .addEdge(START, "agent")
    // leitura → tools; escrita livre → gate de eco; confirm/cancel → apply; nada → responde
    .addConditionalEdges("agent", routeConversation, {
      tools: "tools",
      confirm: "confirm",
      apply: "apply",
      __end__: END,
    })
    .addEdge("tools", "agent")
    // gate → eco determinístico direto (aguarda "sim" no próximo turno). Sem voz-leve por
    // LLM: um modelo pequeno parafraseia e pode omitir dados/segurança do eco (validado ao vivo).
    .addEdge("confirm", END)
    // aplicação da pendência confirmada → responde o desfecho e encerra
    .addEdge("apply", END);

  // checkpointer Postgres: thread_id = conversationId → contexto entre mensagens.
  return workflow.compile({ checkpointer: deps.checkpointer });
}

export type WhatsappConversationGraph = ReturnType<typeof buildWhatsappConversationGraph>;
