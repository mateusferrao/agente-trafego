// Annotation de estado do grafo `account-analysis` (pipeline determinístico).
// O estado é serializável (persiste no checkpointer Postgres p/ interrupt/resume).

import { Annotation } from "@langchain/langgraph";
import type { DecisionResult, GuardrailResult } from "@trafego/core";
import type { MutationResult } from "@trafego/shared/ports";
import type {
  AccountBrief,
  Action,
  AgentGoals,
  AutonomyPolicy,
  CandidateAction,
  Finding,
  GuardrailConfig,
  InsightRow,
  PlaybookRule,
} from "@trafego/shared/types";

export const AccountAnalysisState = Annotation.Root({
  // ── identificação / snapshot congelado do run ──────────────────────────
  runId: Annotation<string>,
  orgId: Annotation<string>,
  agentId: Annotation<string>,
  adAccountId: Annotation<string>,
  trigger: Annotation<"cron" | "on_demand">,

  // config congelada no início do run (reprodutibilidade — CLAUDE §6)
  goals: Annotation<AgentGoals>,
  playbookRules: Annotation<readonly PlaybookRule[]>,
  guardrailConfig: Annotation<GuardrailConfig>,
  autonomyPolicy: Annotation<AutonomyPolicy>,

  // ── dados coletados / derivados ────────────────────────────────────────
  insights: Annotation<readonly InsightRow[]>,
  brief: Annotation<AccountBrief | null>,
  findings: Annotation<readonly Finding[]>,

  // ── ações (híbrido playbook + llm) ─────────────────────────────────────
  playbookCandidates: Annotation<readonly CandidateAction[]>,
  llmCandidates: Annotation<readonly CandidateAction[]>,
  mergedCandidates: Annotation<readonly CandidateAction[]>,
  guardrail: Annotation<GuardrailResult | null>,
  decision: Annotation<DecisionResult | null>,

  // ── HITL ───────────────────────────────────────────────────────────────
  approvalId: Annotation<string | null>,
  approvedActions: Annotation<readonly Action[]>,

  // ── aplicação / saída ──────────────────────────────────────────────────
  results: Annotation<readonly MutationResult[]>,
  // nota de análise parcial (degradação graciosa do governor — CLAUDE §7)
  partial: Annotation<boolean>,
});

export type AccountAnalysisStateType = typeof AccountAnalysisState.State;
export type AccountAnalysisUpdate = Partial<AccountAnalysisStateType>;
