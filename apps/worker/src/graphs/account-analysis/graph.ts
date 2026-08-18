// Grafo `account-analysis` (LangGraph Graph API / StateGraph).
// Pipeline determinístico (CLAUDE §7):
//   load_context → fetch_data → run_playbook → llm_analyze(+visão)
//   → build_recommendations → decide_actions → guardrail_check
//   → [precisa OK? create_approval + interrupt()] → apply_actions(snapshot)
//   → notify → record
// LLM só entra em `llm_analyze` e `notify`.

import { END, START, StateGraph } from "@langchain/langgraph";
import type { WorkerDeps } from "../../composition.js";
import { makeAccountAnalysisNodes, routeApproval } from "./nodes.js";
import { AccountAnalysisState } from "./state.js";

/**
 * Compila o grafo com o checkpointer Postgres injetado (HITL durável:
 * interrupt() no ramo de aprovação, resume num job posterior).
 */
export function buildAccountAnalysisGraph(deps: WorkerDeps) {
  const n = makeAccountAnalysisNodes(deps);

  const workflow = new StateGraph(AccountAnalysisState)
    .addNode("load_context", n.loadContext)
    .addNode("fetch_data", n.fetchData)
    .addNode("run_playbook", n.runPlaybook)
    .addNode("llm_analyze", n.llmAnalyze)
    .addNode("build_recommendations", n.buildRecommendations)
    .addNode("decide_actions", n.decideActions)
    .addNode("guardrail_check", n.guardrailCheck)
    .addNode("create_approval", n.createApprovalAndInterrupt)
    .addNode("apply_actions", n.applyActions)
    .addNode("notify", n.notify)
    .addNode("record", n.record)
    .addEdge(START, "load_context")
    .addEdge("load_context", "fetch_data")
    .addEdge("fetch_data", "run_playbook")
    .addEdge("run_playbook", "llm_analyze")
    .addEdge("llm_analyze", "build_recommendations")
    .addEdge("build_recommendations", "decide_actions")
    .addEdge("decide_actions", "guardrail_check")
    // precisa de OK humano? → cria approval + interrupt(); senão aplica direto
    .addConditionalEdges("guardrail_check", routeApproval, {
      approval: "create_approval",
      apply: "apply_actions",
    })
    .addEdge("create_approval", "apply_actions")
    .addEdge("apply_actions", "notify")
    .addEdge("notify", "record")
    .addEdge("record", END);

  // TODO: tipar deps.checkpointer como BaseCheckpointSaver (PostgresSaver).
  return workflow.compile({ checkpointer: deps.checkpointer as never });
}

export type AccountAnalysisGraph = ReturnType<typeof buildAccountAnalysisGraph>;
