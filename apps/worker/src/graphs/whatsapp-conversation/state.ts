// Annotation de estado do grafo `whatsapp-conversation` (ReAct + tools).
// Chat aberto: perguntas, pedidos ad-hoc, "analisa agora" e resolução de aprovações.

import { Annotation, messagesStateReducer } from "@langchain/langgraph";
import type { BaseMessage } from "@langchain/core/messages";
import type { Action } from "@trafego/shared/types";

/** Ação congelada aguardando confirmação (eco+confirma, 5c). A ação aplicada é ESTA
 *  (já clampada pelo guardrail no gate) — o "sim" não re-especifica nada (sem drift). */
export interface PendingWrite {
  /** eco determinístico já enviado ao usuário (voz leve por cima). */
  readonly echo: string;
  /** ISO — expira p/ não aplicar um "sim" fantasma turnos/tempo depois (TTL). */
  readonly expiresAt: string;
  /** ações clampadas a aplicar quando o usuário confirmar (lote). */
  readonly actions: readonly Action[];
}

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

  // eco+confirma: ação(ões) proposta(s) aguardando confirmação explícita do humano.
  // Antes de QUALQUER escrita → eco concreto + espera "sim". (CLAUDE §8)
  pendingWrite: Annotation<PendingWrite | null>,
});

export type WhatsappConversationStateType = typeof WhatsappConversationState.State;
export type WhatsappConversationUpdate = Partial<WhatsappConversationStateType>;
