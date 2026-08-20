// Grafo `account-analysis` (LangGraph Graph API / StateGraph).
//
// Rota completa (5b corte 1 — auto-apply + aprovação via site; sem checkpointer):
//   load_context → fetch_data → run_playbook → map_units → synthesize
//   → review_analysis → build_recommendations
//   → decide_actions → guardrail_check → apply_actions → create_approvals
//   → write_message → record → notify
// (decide_actions = dedupe/conflito + autonomia por origem; guardrail_check =
//  rede cross-run + budget-level + no-op sobre autoApply E needApproval;
//  apply_actions = escreve/simula via executor; create_approvals = persiste as
//  sugeridas que passaram no guardrail como `approvals` pendentes — o site aprova,
//  e o apply-service (5b-1.3) re-checa fresco + aplica.)

import { END, START, StateGraph } from "@langchain/langgraph";
import type { WorkerDeps } from "../../composition.js";
import { makeAccountAnalysisNodes } from "./nodes.js";
import { AccountAnalysisState } from "./state.js";

export function buildAccountAnalysisGraph(deps: WorkerDeps) {
  const n = makeAccountAnalysisNodes(deps);

  const workflow = new StateGraph(AccountAnalysisState)
    .addNode("load_context", n.loadContext)
    .addNode("fetch_data", n.fetchData)
    .addNode("run_playbook", n.runPlaybook)
    .addNode("map_units", n.mapUnits)
    .addNode("synthesize", n.synthesize)
    .addNode("review_analysis", n.reviewAnalysis)
    .addNode("build_recommendations", n.buildRecommendations)
    .addNode("decide_actions", n.decideActions)
    .addNode("guardrail_check", n.guardrailCheck)
    .addNode("apply_actions", n.applyActions)
    .addNode("create_approvals", n.createApprovals)
    .addNode("write_message", n.writeMessage)
    .addNode("record", n.record)
    .addNode("notify", n.notify)
    .addEdge(START, "load_context")
    .addEdge("load_context", "fetch_data")
    .addEdge("fetch_data", "run_playbook")
    .addEdge("run_playbook", "map_units")
    .addEdge("map_units", "synthesize")
    .addEdge("synthesize", "review_analysis")
    .addEdge("review_analysis", "build_recommendations")
    .addEdge("build_recommendations", "decide_actions")
    .addEdge("decide_actions", "guardrail_check")
    .addEdge("guardrail_check", "apply_actions")
    .addEdge("apply_actions", "create_approvals")
    .addEdge("create_approvals", "write_message")
    .addEdge("write_message", "record")
    .addEdge("record", "notify")
    .addEdge("notify", END);

  return workflow.compile();
}

export type AccountAnalysisGraph = ReturnType<typeof buildAccountAnalysisGraph>;
