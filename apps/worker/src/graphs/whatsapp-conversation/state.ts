// Annotation de estado do grafo `whatsapp-conversation` (ReAct + tools).
// Chat aberto: perguntas, pedidos ad-hoc, "analisa agora" e resolução de aprovações.

import { Annotation, messagesStateReducer } from "@langchain/langgraph";
import type { BaseMessage } from "@langchain/core/messages";
import type { Action, AutonomyPolicy, GuardrailConfig } from "@trafego/shared/types";
import type { AgentConfigPatch } from "@trafego/core";

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

/**
 * Rascunho de campanha aguardando confirmação (eco+confirma, Fatia 7). Já persistido em
 * `campaign_drafts(proposed)` + `approvals(pending)` no gate (fonte única visível no site);
 * o "sim" só enfileira a saga de criação (mesmo apply-service do site). Serializável.
 */
export interface PendingDraft {
  readonly echo: string;
  readonly expiresAt: string;
  /** id da aprovação de rascunho a resolver (enfileira apply-draft). */
  readonly approvalId: string;
  /** id do rascunho (campaign_drafts) — alvo do refinamento conversacional (ajustar/regenerar). */
  readonly draftId: string;
}

/** Reversão(ões) aguardando confirmação (eco+confirma, 5c-4). */
export interface PendingRevert {
  readonly echo: string;
  readonly expiresAt: string;
  /** ids de agent_tool_calls a reverter quando o usuário confirmar. */
  readonly toolCallIds: readonly string[];
}

/**
 * Regra de playbook proposta/afetada por chat (S2.5), congelada no gate. Serializável
 * (vai pro checkpointer). `add` carrega a regra a inserir; `toggle`/`remove` referenciam
 * uma regra existente por id (resolvido no list). O que se aplica é ESTE congelado.
 */
export interface PendingPlaybookOp {
  readonly kind: "add" | "toggle" | "remove";
  /** regra a inserir (kind=add) — shape neutro do playbookRuleInput da API. */
  readonly rule?: {
    readonly scope: "campaign" | "adset" | "ad";
    readonly metric: string;
    readonly op: string;
    readonly value: number;
    readonly minSpend?: number;
    readonly then: { readonly type: string } & Record<string, unknown>;
  };
  /** id da regra existente (kind=toggle|remove). */
  readonly ruleId?: string;
  /** novo estado (kind=toggle). */
  readonly enabled?: boolean;
}

/**
 * Mudança de CONFIG do agente aguardando confirmação (eco+confirma, S2.3). Serializável
 * (congelada no checkpointer). `update` = patch de config; `reseed` = re-seed de arquétipo;
 * `playbook` = CRUD de regra. O "sim" NÃO re-especifica nada — aplica-se o CONGELADO.
 */
export interface PendingConfigChange {
  /** eco determinístico já enviado ao usuário. */
  readonly echo: string;
  /** ISO — TTL (um "sim" tardio não aplica algo esquecido). */
  readonly expiresAt: string;
  readonly kind: "update" | "reseed" | "playbook";
  /** patch de config (kind=update). */
  readonly patch?: AgentConfigPatch;
  /** arquétipo a re-semear (kind=reseed). */
  readonly archetype?: string;
  /** operação de playbook (kind=playbook). */
  readonly playbook?: PendingPlaybookOp;
  /**
   * Foto da config de SEGURANÇA no momento do eco (guardrails + autonomia), quando o
   * patch a toca (kind=update). O apply re-lê fresco e ABORTA se mudou desde o eco —
   * senão o patch absoluto congelado reverteria em silêncio um endurecimento concorrente
   * (ex: kill-switch ligado pelo site enquanto a pendência estava aberta).
   */
  readonly securityBaseline?: { readonly guardrails: GuardrailConfig; readonly autonomyPolicy: AutonomyPolicy };
  /** a mudança afrouxa a rede de segurança (aviso no eco). */
  readonly weakensSafety: boolean;
  /** um campo relevante à análise mudou → oferecer rodar análise após aplicar. */
  readonly runRelevantChanged: boolean;
}

/**
 * Escolha numerada pendente (Fatia 7): desambiguação de campanha/público. Serializável
 * (vai pro checkpointer). A resposta do usuário ("1") resolve pelo `id` da opção — a casca
 * não deixa o LLM re-mapear nome→id (evita a misatribuição cross-entity do telefone).
 */
export interface PendingChoice {
  readonly kind: "campaign" | "audience";
  /** ISO — TTL (uma escolha tardia não resolve algo esquecido). */
  readonly expiresAt: string;
  readonly options: readonly { readonly n: number; readonly id: string; readonly name: string }[];
}

export const WhatsappConversationState = Annotation.Root({
  // histórico da conversa (reducer append padrão do LangGraph)
  messages: Annotation<BaseMessage[]>({
    reducer: messagesStateReducer,
    default: () => [],
  }),

  // contexto do tenant/conta resolvido no início do turno
  orgId: Annotation<string>,
  agentId: Annotation<string>,
  adAccountId: Annotation<string>,

  // aprovação pendente que este turno pode resolver (HITL conversacional)
  pendingApprovalId: Annotation<string | null>,

  // eco+confirma: ação(ões) proposta(s) aguardando confirmação explícita do humano.
  // Antes de QUALQUER escrita → eco concreto + espera "sim". (CLAUDE §8)
  pendingWrite: Annotation<PendingWrite | null>,

  // eco+confirma de REVERSÃO (5c-4) — desfazer também é escrita.
  pendingRevert: Annotation<PendingRevert | null>,

  // eco+confirma de RASCUNHO de campanha (Fatia 7) — criar/escalar (gasto novo).
  pendingDraft: Annotation<PendingDraft | null>,

  // eco+confirma de mudança de CONFIG do agente (S2.3): metas/autonomia/guardrails/
  // cadência/arquétipo/playbook/identidade. Config não toca a Meta (ramo próprio).
  pendingConfigChange: Annotation<PendingConfigChange | null>,

  // âncora determinística de escolha numerada (Fatia 7): quando um nome fica ambíguo
  // (campanha p/ copiar, público p/ segmentar), a casca lista opções numeradas COM id e
  // grava aqui; "pode ser a 1" resolve 1→id SEM o LLM re-mapear nome→id (fecha a porta de
  // misatribuição). Simétrico ao foco de conta determinístico (`resolveFocusMatch`).
  pendingChoice: Annotation<PendingChoice | null>,
});

export type WhatsappConversationStateType = typeof WhatsappConversationState.State;
export type WhatsappConversationUpdate = Partial<WhatsappConversationStateType>;
