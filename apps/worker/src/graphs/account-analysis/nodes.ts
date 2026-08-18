// Nós FINOS do grafo `account-analysis`: só IO + orquestração. Toda regra vive
// nas funções puras de `@trafego/core` (playbook/guardrails/decision/brief),
// testadas sem mock. Cada nó retorna um patch parcial do estado.

import { interrupt } from "@langchain/langgraph";
// Fns puras de @trafego/core. Assinaturas reais:
//   assembleBrief(input) => AccountBrief
//   evaluatePlaybook(rules, insights) => CandidateAction[]
//   applyGuardrails(actions, config) => GuardrailOutcome
//   decideActions(actions, policy) => DecisionOutcome
import { applyGuardrails, decideActions, evaluatePlaybook } from "@trafego/core";
import type { WorkerDeps } from "../../composition.js";
import type { AccountAnalysisStateType, AccountAnalysisUpdate } from "./state.js";

/** Fábrica de nós com deps injetadas (composition root passa `deps`). */
export function makeAccountAnalysisNodes(deps: WorkerDeps) {
  const { logger } = deps;

  /** Carrega agent/config/guardrails/autonomia e congela snapshot do run. */
  async function loadContext(state: AccountAnalysisStateType): Promise<AccountAnalysisUpdate> {
    logger.debug({ runId: state.runId }, "load_context");
    // TODO: buscar agent + guardrail_configs + playbook_rules + autonomy_policy (db, org-scoped).
    // TODO: abrir agent_run (status=running, trace_id) para auditoria.
    // TODO: descriptografar token via CredentialVaultPort → montar AdAccountRef.
    return {};
  }

  /** Coleta insights + entidades via AdsPlatformPort (governor/cache no adapter). */
  async function fetchData(state: AccountAnalysisStateType): Promise<AccountAnalysisUpdate> {
    logger.debug({ runId: state.runId }, "fetch_data");
    // TODO: deps.ports.ads.getInsights(...) + listEntities(...); persistir insights_snapshots.
    // TODO: em rate-limit/erro parcial → setar partial=true (degradação graciosa).
    return { insights: [], partial: false };
  }

  /** Regras determinísticas → ações-base (funções puras do core). */
  async function runPlaybookNode(state: AccountAnalysisStateType): Promise<AccountAnalysisUpdate> {
    logger.debug({ runId: state.runId }, "run_playbook");
    // Playbook roda sobre os insights crus (após fetch_data). Os candidates
    // alimentam o AccountBrief mais adiante.
    const playbookCandidates = evaluatePlaybook(state.playbookRules, state.insights);
    return { playbookCandidates };
  }

  /**
   * Curadoria determinística (AccountBrief) + análise LLM (texto + visão dos
   * criativos flagados). LLM só vê o brief, nunca o firehose.
   */
  async function llmAnalyze(state: AccountAnalysisStateType): Promise<AccountAnalysisUpdate> {
    logger.debug({ runId: state.runId }, "llm_analyze");
    // TODO (3a): brief = assembleBrief({ ... }) — montar o input real de curadoria
    //            (normalize → rank/select → creatives) antes de chamar o LLM.
    // TODO: deps.ports.llm.completeStructured<{ findings; actions }>(...) com brief + imagens.
    // TODO: registrar usage/custo via MeteringPort (cap de custo llm — guardrail_configs).
    return { brief: state.brief, findings: [], llmCandidates: [] };
  }

  /** Constrói recommendations (persistidas p/ feedback + outcome tracking). */
  async function buildRecommendations(
    state: AccountAnalysisStateType,
  ): Promise<AccountAnalysisUpdate> {
    logger.debug({ runId: state.runId }, "build_recommendations");
    // TODO: gravar recommendations(title, rationale, proposed_action, status='proposed').
    return {};
  }

  /** Merge playbook+llm → dedupe. Autonomia decidida POR ORIGEM (core puro). */
  async function decideActionsNode(
    state: AccountAnalysisStateType,
  ): Promise<AccountAnalysisUpdate> {
    logger.debug({ runId: state.runId }, "decide_actions");
    // TODO: dedupe determinístico (mesmo target+type) preferindo maior riskLevel/confiança.
    const mergedCandidates = [...state.playbookCandidates, ...state.llmCandidates];
    const decision = decideActions(mergedCandidates, state.autonomyPolicy);
    return { mergedCandidates, decision };
  }

  /** Rede de segurança sobre AMBAS as origens (blast radius, cap, kill-switch, dry-run). */
  async function guardrailCheck(state: AccountAnalysisStateType): Promise<AccountAnalysisUpdate> {
    logger.debug({ runId: state.runId }, "guardrail_check");
    const candidates = state.decision
      ? [...state.decision.autoApply, ...state.decision.needApproval]
      : state.mergedCandidates;
    const guardrail = applyGuardrails(candidates, state.guardrailConfig);
    return { guardrail };
  }

  /**
   * Cria a Approval (HITL) e PAUSA o grafo via interrupt(). O resume acontece
   * num novo job quando a resposta no WhatsApp resolve a aprovação.
   * Aprovação conversacional (eco+confirma) é regra do Grafo B, não deste nó.
   */
  async function createApprovalAndInterrupt(
    state: AccountAnalysisStateType,
  ): Promise<AccountAnalysisUpdate> {
    logger.debug({ runId: state.runId }, "create_approval + interrupt");
    // TODO: approval = await deps.ports.approval.create({ runId, contactId, actions, expiresAt: now+24h }).
    // TODO: notificar contato no WhatsApp com o eco em linguagem natural.
    const decision = interrupt({
      type: "approval_required",
      runId: state.runId,
      // TODO: enviar as ações que precisam de OK.
      actions: state.decision?.needApproval ?? [],
    });
    // Ao resumir, `decision` traz as ações aprovadas (mapeadas pelo Grafo B).
    return { approvedActions: (decision as { approvedActions?: never[] })?.approvedActions ?? [] };
  }

  /** Aplica mutações idempotentes (idempotencyKey + before_state p/ rollback). */
  async function applyActions(state: AccountAnalysisStateType): Promise<AccountAnalysisUpdate> {
    logger.debug({ runId: state.runId }, "apply_actions");
    // TODO: para cada ação (autoApply + approvedActions): executor meta-tools → snapshot before_state
    //       + agent_tool_calls(idempotency_key). Nunca aplica a mesma mutação 2x.
    return { results: [] };
  }

  /** Notifica o resultado no WhatsApp (LLM redige a mensagem). */
  async function notify(state: AccountAnalysisStateType): Promise<AccountAnalysisUpdate> {
    logger.debug({ runId: state.runId }, "notify");
    // TODO: deps.ports.messaging.sendMessage(...) com resumo do que foi feito/sugerido.
    return {};
  }

  /** Fecha o run: status, cost_snapshot, token_usage, audit. */
  async function record(state: AccountAnalysisStateType): Promise<AccountAnalysisUpdate> {
    logger.debug({ runId: state.runId }, "record");
    // TODO: fechar agent_run (status=done), gravar usage_events + audit_log.
    return {};
  }

  return {
    loadContext,
    fetchData,
    runPlaybook: runPlaybookNode,
    llmAnalyze,
    buildRecommendations,
    decideActions: decideActionsNode,
    guardrailCheck,
    createApprovalAndInterrupt,
    applyActions,
    notify,
    record,
  };
}

/**
 * Aresta condicional após o guardrail: precisa de OK humano?
 * Se há ações em `needApproval` (e guardrail liberou) → ramo de aprovação.
 */
export function routeApproval(state: AccountAnalysisStateType): "approval" | "apply" {
  const needs = state.decision?.needApproval.length ?? 0;
  return needs > 0 ? "approval" : "apply";
}
