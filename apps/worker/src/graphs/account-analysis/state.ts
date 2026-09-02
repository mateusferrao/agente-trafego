// Annotation de estado do grafo `account-analysis` (pipeline determinístico).
// O estado é serializável (persiste no checkpointer Postgres p/ interrupt/resume).

import { Annotation } from "@langchain/langgraph";
import type { AccumulatedTokenUsage, DecisionResult, DroppedAction, GuardrailOpportunity, GuardrailResult, LessonBrief, LessonGuard } from "@trafego/core";
import type { AgentRunTrigger, MarketReference, NotifyPolicy, PartialReason, Posture, RunNotifyTarget, SignalFinding } from "@trafego/shared";
import type { MutationResult } from "@trafego/shared/ports";
import type {
  AccountBrief,
  Action,
  AdEntity,
  AgentGoals,
  AutonomyPolicy,
  CandidateAction,
  Creative,
  EntityBreakdown,
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
  // aprendizado contínuo: lições confirmadas/alta confiança → texto do analista (rotuladas).
  lessons: Annotation<readonly LessonBrief[]>,
  // hipóteses não-confirmadas → guard assimétrico (S3); nunca entram no texto do prompt.
  lessonGuards: Annotation<readonly LessonGuard[]>,
  // há prior MEDIDO de que escalar compensa nesta conta (account_scale_pays) — condição do
  // aviso de oportunidade de guardrail (v3). Computado no load_context (tem as chaves das lições).
  hasScalePaysPrior: Annotation<boolean>,
  guardrailConfig: Annotation<GuardrailConfig>,
  autonomyPolicy: Annotation<AutonomyPolicy>,
  // política de notificação (F4): governa o push do cron (runPush) no writeMessage.
  notifyPolicy: Annotation<NotifyPolicy | null>,
  // postura de comunicação (voz): aplicada no redator do push (composePostureBlock + volume).
  posture: Annotation<Posture | null>,

  // ── contexto carregado (loadContext) ───────────────────────────────────
  account: Annotation<AnalysisAccount | null>,
  // voz do ANALISTA (composeAgentVoice: metodologia/override + identidade + personalização),
  // SEM kernel/postura (emite JSON, não fala com o dono).
  systemPrompt: Annotation<string>,
  // voz de FALA do redator (composeSpeakingVoice: voz-base + kernel de marca + postura) —
  // fonte única com o chat/pulso. Separada do systemPrompt do analista.
  speakingPrompt: Annotation<string>,
  // perfil vertical do agente (S4) — resolve pra packages/core/src/verticals no prompt.
  vertical: Annotation<string>,
  // epoch ms de quando a config relevante à análise mudou (força 1 deep — Fatia 4); null se nunca.
  configChangedAt: Annotation<number | null>,
  analysisConfig: Annotation<ResolvedAnalysisConfig | null>,
  window: Annotation<AnalysisWindow | null>,
  baseline: Annotation<AnalysisWindow | null>,
  // campanhas silenciadas pelo usuário (S5) — excluídas da análise por campanha.
  mutedCampaignIds: Annotation<readonly string[]>,
  // referência de mercado (pivô): org-default + override por agente — resolvidos na
  // moeda da conta no mapUnits (match-or-drop). null = não configurada.
  orgMarketReference: Annotation<MarketReference | null>,
  agentMarketReference: Annotation<MarketReference | null>,

  // ── dados coletados / derivados ────────────────────────────────────────
  entities: Annotation<readonly AdEntity[]>,
  insights: Annotation<readonly InsightRow[]>,
  baselineInsights: Annotation<readonly InsightRow[]>,
  creatives: Annotation<readonly Creative[]>,
  // Breakdown demográfico/posicionamento da CONTA (S7) — cru, sem gate de materialidade
  // ainda (aplicado dentro de `buildAccountBrief`); null = sem dado (nunca sincronizado
  // ainda, ou cadência própria não venceu neste ciclo).
  demographics: Annotation<EntityBreakdown | null>,
  placements: Annotation<EntityBreakdown | null>,
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
  // a msg carrega uma oferta de ligar a REATIVAÇÃO (empty-state, F4): o notify foca a conta-alvo
  // na conversa org-level, pra a resposta ("sim") conseguir ligar por chat (fecha a contradição
  // oferta-proativa × concierge multi-conta). Só o empty-state seta — blast radius mínimo.
  offersReactivation: Annotation<boolean>,
  // narrativa voiceada (SEMPRE renderada quando há análise) — persistida no run p/ o
  // site exibir; independe da decisão de ENTREGA (outboundMessage). null = sem análise.
  narrative: Annotation<string | null>,

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
  // aviso de OPORTUNIDADE de guardrail (v3, "sinal vivo"): o teto de budget clampou uma escala
  // que um prior medido diz compensar. Só APONTA pra config — nunca muta o guardrail.
  guardrailOpportunity: Annotation<GuardrailOpportunity | null>,

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
