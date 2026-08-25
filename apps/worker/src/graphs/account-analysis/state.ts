// Annotation de estado do grafo `account-analysis` (pipeline determinístico).
// O estado é serializável (persiste no checkpointer Postgres p/ interrupt/resume).

import { Annotation } from "@langchain/langgraph";
import type { AccumulatedTokenUsage, DecisionResult, DroppedAction, GuardrailResult } from "@trafego/core";
import type { AgentRunTrigger, NotifyPolicy, PartialReason, RunNotifyTarget, SignalFinding } from "@trafego/shared";
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
  RunCampaignCard,
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
  trigger: Annotation<AgentRunTrigger>,
  // alvo de push (5b-2): quando o run é disparado pelo WhatsApp, o resultado volta
  // na conversa (writeMessage/notify honram isto além do cron). null = sem push.
  // (nome != nó "notify" do grafo — LangGraph proíbe state key == node name)
  notifyTarget: Annotation<RunNotifyTarget | null>,
  // sinal que disparou o run (trigger "signal", F4): dirige o olhar do analista. null = run normal.
  signalFinding: Annotation<SignalFinding | null>,

  // config congelada no início do run (reprodutibilidade — CLAUDE §6)
  goals: Annotation<AgentGoals>,
  playbookRules: Annotation<readonly PlaybookRule[]>,
  // memória "rejeitado" (loop de feedback) — injetada no brief p/ não repetir vetos.
  rejectedMemory: Annotation<readonly string[]>,
  guardrailConfig: Annotation<GuardrailConfig>,
  autonomyPolicy: Annotation<AutonomyPolicy>,
  // política de notificação (F4): governa o push do cron (runPush) no writeMessage.
  notifyPolicy: Annotation<NotifyPolicy | null>,

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
  // cartões por-campanha (fresh + herdadas) congelados p/ o histórico (snapshot no run).
  campaignCards: Annotation<readonly RunCampaignCard[]>,
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
  // ações barradas pelo guardrail (autoApply + needApproval) — expostas no snapshot
  // como "barradas" (motivo). Só log antes; agora visível pro usuário (5b).
  droppedActions: Annotation<readonly DroppedAction[]>,
  // needApproval que PASSARAM no guardrail → viram linhas `approvals` (create_approvals).
  approvalCandidates: Annotation<readonly Action[]>,

  // ── HITL ───────────────────────────────────────────────────────────────
  approvalId: Annotation<string | null>,
  approvedActions: Annotation<readonly Action[]>,

  // ── aplicação / saída ──────────────────────────────────────────────────
  results: Annotation<readonly MutationResult[]>,
  // nota de análise parcial (degradação graciosa do governor — CLAUDE §7)
  partial: Annotation<boolean>,
  // POR QUE degradou — ACUMULADO (união) entre nós, então cada fonte só retorna o seu
  // motivo e não precisa reler/threadar o estado. Alimenta a nota proporcional na UI.
  partialReasons: Annotation<readonly PartialReason[]>({
    reducer: (a, b) => [...new Set([...(a ?? []), ...(b ?? [])])],
    default: () => [],
  }),
});

export type AccountAnalysisStateType = typeof AccountAnalysisState.State;
export type AccountAnalysisUpdate = Partial<AccountAnalysisStateType>;
