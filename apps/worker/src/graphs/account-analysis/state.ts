// Annotation de estado do grafo `account-analysis` (pipeline determinístico).
// O estado é serializável (persiste no checkpointer Postgres p/ interrupt/resume).

import { Annotation } from "@langchain/langgraph";
import type { AccumulatedTokenUsage, DecisionResult, GuardrailResult } from "@trafego/core";
import type { MutationResult } from "@trafego/shared/ports";
import type {
  AccountBrief,
  Action,
  AdEntity,
  AgentGoals,
  AutonomyPolicy,
  CandidateAction,
  Creative,
  Finding,
  GuardrailConfig,
  InsightRow,
  PlaybookRule,
} from "@trafego/shared/types";
import type { AnalysisOutput, UnitAnalysis } from "@trafego/shared/schemas";
import type { ResolvedAnalysisConfig } from "../../modules/analysis/config.js";
import type { SaveEntityAnalysis } from "../../modules/analysis/entity-analyses.repo.js";

/** Janela temporal resolvida (rótulo p/ o brief + datas p/ o fetch). */
export interface AnalysisWindow {
  readonly label: string;
  readonly since: string; // YYYY-MM-DD
  readonly until: string; // YYYY-MM-DD
}

/** Metadados não-secretos da conta (token nunca entra no estado). */
export interface AnalysisAccount {
  readonly metaAdAccountId: string;
  readonly name: string;
  readonly currency: string;
}

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
  // memória "rejeitado" (loop de feedback) — injetada no brief p/ não repetir vetos.
  rejectedMemory: Annotation<readonly string[]>,
  guardrailConfig: Annotation<GuardrailConfig>,
  autonomyPolicy: Annotation<AutonomyPolicy>,

  // ── contexto carregado (loadContext) ───────────────────────────────────
  account: Annotation<AnalysisAccount | null>,
  systemPrompt: Annotation<string>,
  // epoch ms de quando a config relevante à análise mudou (força 1 deep — Fatia 4); null se nunca.
  configChangedAt: Annotation<number | null>,
  analysisConfig: Annotation<ResolvedAnalysisConfig | null>,
  window: Annotation<AnalysisWindow | null>,
  baseline: Annotation<AnalysisWindow | null>,
  // campanhas silenciadas pelo usuário (S5) — excluídas da análise por campanha.
  mutedCampaignIds: Annotation<readonly string[]>,

  // ── dados coletados / derivados ────────────────────────────────────────
  entities: Annotation<readonly AdEntity[]>,
  insights: Annotation<readonly InsightRow[]>,
  baselineInsights: Annotation<readonly InsightRow[]>,
  creatives: Annotation<readonly Creative[]>,
  brief: Annotation<AccountBrief | null>,
  findings: Annotation<readonly Finding[]>,
  // map-reduce (3b-2): análises por-anúncio (novas + herdadas) + as a persistir.
  unitAnalyses: Annotation<readonly UnitAnalysis[]>,
  freshUnits: Annotation<readonly SaveEntityAnalysis[]>,
  analysisOutput: Annotation<AnalysisOutput | null>,
  summary: Annotation<string>,
  usage: Annotation<AccumulatedTokenUsage | null>,
  // mensagem de WhatsApp redigida (3b); null = nada acionável / não é cron → silêncio.
  outboundMessage: Annotation<string | null>,

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
