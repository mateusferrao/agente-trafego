// Grafo `account-analysis` (LangGraph Graph API / StateGraph).
//
// 3a = rota READ-ONLY (sem escrita na Meta, sem HITL, sem checkpointer):
//   load_context → fetch_data → run_playbook → llm_analyze
//   → build_recommendations → record
//
// A metade de escrita (decide_actions → guardrail_check → [approval] →
// apply_actions → notify) entra a partir de 3b/5a/5b — os nós já existem
// (scaffold em nodes.ts) e o checkpointer Postgres é plugado então.

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
    .addNode("llm_analyze", n.llmAnalyze)
    .addNode("build_recommendations", n.buildRecommendations)
    .addNode("record", n.record)
    .addEdge(START, "load_context")
    .addEdge("load_context", "fetch_data")
    .addEdge("fetch_data", "run_playbook")
    .addEdge("run_playbook", "llm_analyze")
    .addEdge("llm_analyze", "build_recommendations")
    .addEdge("build_recommendations", "record")
    .addEdge("record", END);

  return workflow.compile();
}

export type AccountAnalysisGraph = ReturnType<typeof buildAccountAnalysisGraph>;
