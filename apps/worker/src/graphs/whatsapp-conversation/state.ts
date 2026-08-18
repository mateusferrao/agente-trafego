// Annotation de estado do grafo `whatsapp-conversation` (ReAct + tools).
// Chat aberto: perguntas, pedidos ad-hoc, "analisa agora" e resolução de aprovações.

import { Annotation, messagesStateReducer } from "@langchain/langgraph";
import type { BaseMessage } from "@langchain/core/messages";

export const WhatsappConversationState = Annotation.Root({
  // histórico da conversa (reducer append padrão do LangGraph)
  messages: Annotation<BaseMessage[]>({
    reducer: messagesStateReducer,
    default: () => [],
  }),

  // contexto do tenant/conta resolvido no início do turno
  orgId: Annotation<string>,
  contactId: Annotation<string>,
  agentId: Annotation<string>,
  adAccountId: Annotation<string>,

  // aprovação pendente que este turno pode resolver (HITL conversacional)
  pendingApprovalId: Annotation<string | null>,

  // eco+confirma: ação proposta aguardando confirmação explícita do humano.
  // Antes de QUALQUER escrita → eco concreto + espera "sim". (CLAUDE §8)
  pendingWrite: Annotation<{ readonly echo: string; readonly toolCallId: string } | null>,
});

export type WhatsappConversationStateType = typeof WhatsappConversationState.State;
export type WhatsappConversationUpdate = Partial<WhatsappConversationStateType>;
