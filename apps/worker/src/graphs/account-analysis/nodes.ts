// Nós FINOS do grafo `account-analysis`: só IO + orquestração. Toda regra vive
// nas funções puras de `@trafego/core` (playbook/guardrails/decision/brief),
// testadas sem mock. Cada nó retorna um patch parcial do estado.
//
// 3a = rota READ-ONLY: load_context → fetch_data → run_playbook → llm_analyze →
// build_recommendations → record. A metade de escrita (decide/guardrail/approval/
// apply/notify) fica scaffolded p/ 3b/4/5a/5b.

import { interrupt } from "@langchain/langgraph";
import {
  addTokenUsage,
  applicableActionType,
  applyGuardrails,
  archetypeDefaults,
  budgetDirection,
  buildAccountBrief,
  costSnapshotFromUsage,
  decideActions,
  evaluatePlaybook,
  riskLevelForActionType,
} from "@trafego/core";
import {
  analysisOutputSchema,
  ANALYSIS_OUTPUT_JSON_SCHEMA,
  ANALYSIS_OUTPUT_SCHEMA_NAME,
  type AnalysisOutput,
  type AnalysisRecommendation,
} from "@trafego/shared/schemas";
import type { Action, AdEntity, EntityLevel, Finding } from "@trafego/shared";
import type { AdsPlatformPort } from "@trafego/shared/ports";
import { AdsPlatformError } from "@trafego/shared/ports";
import type { WorkerDeps } from "../../composition.js";
import {
  createDrizzleInsightsSnapshotsRepo,
  type InsightsSnapshotsRepo,
} from "../../modules/insights/repo.js";
import { createAnalysisRepo, type AnalysisRepo, type RecommendationRow } from "../../modules/analysis/repo.js";
import { AnalysisError } from "../../modules/analysis/errors.js";
import { buildAnalysisMessages } from "../../modules/analysis/prompt.js";
import { resolveWindows } from "../../modules/analysis/window.js";
import type { AccountAnalysisStateType, AccountAnalysisUpdate } from "./state.js";

const SEGMENT_LEVELS: readonly EntityLevel[] = ["campaign", "adset", "ad"];
const ANALYSIS_TEMPERATURE = 0.2;
const NO_ACTIVITY_SUMMARY =
  "Sua conta não teve gasto nem impressões no período. Não há o que analisar por enquanto.";

/** Data de hoje (YYYY-MM-DD, UTC) — IO/relógio fica na casca. */
function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Repos usados pelos nós — injetáveis p/ teste (default = Drizzle sobre deps.db). */
export interface AnalysisNodeRepos {
  readonly repo: AnalysisRepo;
  readonly snapshots: InsightsSnapshotsRepo;
}

/** Fábrica de nós com deps injetadas (composition root passa `deps`). */
export function makeAccountAnalysisNodes(deps: WorkerDeps, repos?: Partial<AnalysisNodeRepos>) {
  const { logger } = deps;
  const repo = repos?.repo ?? createAnalysisRepo(deps.db);
  const snapshots = repos?.snapshots ?? createDrizzleInsightsSnapshotsRepo(deps.db);

  /** Carrega agent/config/janela e abre o run (status=running, snapshot congelado). */
  async function loadContext(state: AccountAnalysisStateType): Promise<AccountAnalysisUpdate> {
    logger.debug({ runId: state.runId }, "load_context");
    const ctx = await repo.loadAgentContext(state.orgId, state.agentId);
    if (!ctx) throw new AnalysisError("agent_missing", "agente não encontrado");

    const systemPrompt = ctx.systemPrompt ?? archetypeDefaults(ctx.archetype).systemPrompt;
    const { window, baseline } = resolveWindows(
      today(),
      deps.analysis.windowDays,
      deps.analysis.baselineDays,
    );
    const windowLabel = `últimos ${deps.analysis.windowDays} dias`;
    const baselineLabel = `${deps.analysis.baselineDays} dias anteriores`;

    await repo.openRun(state.orgId, state.runId, {
      goals: ctx.goals,
      model: deps.analysis.model,
      window,
      baseline,
      topN: deps.analysis.topN,
    });

    return {
      goals: ctx.goals,
      playbookRules: ctx.playbook,
      systemPrompt,
      window: { label: windowLabel, ...window },
      baseline: { label: baselineLabel, ...baseline },
      usage: null,
      partial: false,
    };
  }

  /** Coleta insights (sync incremental fresco + leitura da janela) + entidades. */
  async function fetchData(state: AccountAnalysisStateType): Promise<AccountAnalysisUpdate> {
    logger.debug({ runId: state.runId }, "fetch_data");
    const account = await repo.loadAccount(state.orgId, state.adAccountId);
    if (!account) throw new AnalysisError("account_missing", "conta não encontrada");
    if (!state.window || !state.baseline) throw new AnalysisError("analysis_failed", "janela não resolvida");

    const accessToken = deps.ports.vault.decrypt(account.tokenCripto);
    const ref = { adAccountId: account.metaAdAccountId, accessToken };

    // sync incremental fresco (reusa 2a) — pega dados atuais antes de ler a janela.
    const sync = await deps.insightsSync.sync({
      orgId: state.orgId,
      adAccountUuid: state.adAccountId,
      metaAdAccountId: account.metaAdAccountId,
      accessToken,
      today: state.window.until,
    });
    if (sync.tokenInvalid) {
      await repo.markTokenInvalid(state.orgId, state.adAccountId);
      throw new AnalysisError("token_invalid", "token Meta inválido (190)");
    }

    const { entities, entitiesPartial } = await fetchEntities(deps.ports.ads, ref, logger);
    const insights = await snapshots.listWindow(
      state.orgId,
      state.adAccountId,
      state.window.since,
      state.window.until,
    );
    const baselineInsights = await snapshots.listWindow(
      state.orgId,
      state.adAccountId,
      state.baseline.since,
      state.baseline.until,
    );

    return {
      account: {
        metaAdAccountId: account.metaAdAccountId,
        name: account.name,
        currency: account.currency,
      },
      entities,
      insights,
      baselineInsights,
      partial: sync.partial || entitiesPartial,
    };
  }

  /** Regras determinísticas → ações-base (funções puras do core). */
  async function runPlaybookNode(state: AccountAnalysisStateType): Promise<AccountAnalysisUpdate> {
    logger.debug({ runId: state.runId }, "run_playbook");
    const playbookCandidates = evaluatePlaybook(state.playbookRules, state.insights);
    return { playbookCandidates };
  }

  /** Curadoria (AccountBrief) + análise LLM (texto). LLM só vê o brief. */
  async function llmAnalyze(state: AccountAnalysisStateType): Promise<AccountAnalysisUpdate> {
    logger.debug({ runId: state.runId }, "llm_analyze");
    if (!state.account || !state.window || !state.baseline) {
      throw new AnalysisError("analysis_failed", "contexto incompleto");
    }

    const built = buildAccountBrief({
      account: {
        id: state.account.metaAdAccountId,
        name: state.account.name,
        currency: state.account.currency,
      },
      window: state.window.label,
      baselineWindow: state.baseline.label,
      goals: state.goals,
      entities: state.entities,
      rows: state.insights,
      baselineRows: state.baselineInsights,
      playbookCandidates: state.playbookCandidates,
      topN: deps.analysis.topN,
    });

    // conta parada (ICP entre lançamentos) → não gasta LLM, run conclui com nota.
    if (built.status === "empty") {
      return { brief: null, analysisOutput: null, findings: [], summary: NO_ACTIVITY_SUMMARY };
    }

    const messages = buildAnalysisMessages(state.systemPrompt, built.brief);
    const completion = await deps.ports.llm.completeStructured<AnalysisOutput>({
      model: deps.analysis.model,
      messages,
      responseSchema: ANALYSIS_OUTPUT_JSON_SCHEMA,
      responseSchemaName: ANALYSIS_OUTPUT_SCHEMA_NAME,
      temperature: ANALYSIS_TEMPERATURE,
    });

    const parsed = analysisOutputSchema.safeParse(completion.output);
    if (!parsed.success) throw new AnalysisError("analysis_failed", "output do LLM fora do schema");

    const findings: Finding[] = parsed.data.findings.map((f) => ({
      title: f.title,
      detail: f.detail,
      severity: f.severity,
    }));

    return {
      brief: built.brief,
      analysisOutput: parsed.data,
      findings,
      summary: parsed.data.summary,
      usage: addTokenUsage(state.usage ?? undefined, completion.usage),
    };
  }

  /** Persiste recommendations (feedback/outcome tracking + base p/ 5a). */
  async function buildRecommendations(
    state: AccountAnalysisStateType,
  ): Promise<AccountAnalysisUpdate> {
    logger.debug({ runId: state.runId }, "build_recommendations");
    if (!state.analysisOutput) return {};
    const knownIds = new Set(state.entities.map((e) => e.id));
    const rows = state.analysisOutput.recommendations.map((rec) =>
      toRecommendationRow(rec, state.orgId, state.runId, knownIds),
    );
    await repo.saveRecommendations(rows);
    return {};
  }

  /** Fecha o run (status=done, summary, partial, custo/usage). */
  async function record(state: AccountAnalysisStateType): Promise<AccountAnalysisUpdate> {
    logger.debug({ runId: state.runId }, "record");
    const usage = state.usage;
    await repo.closeRun(state.orgId, state.runId, {
      status: "succeeded",
      summary: state.summary ?? null,
      partial: state.partial ?? false,
      tokenUsage: usage ? { ...usage } : null,
      costSnapshot: usage ? costSnapshotFromUsage(usage) : null,
    });
    return {};
  }

  // ── metade de escrita (scaffold — 3b/4/5a/5b) ──────────────────────────
  async function decideActionsNode(
    state: AccountAnalysisStateType,
  ): Promise<AccountAnalysisUpdate> {
    logger.debug({ runId: state.runId }, "decide_actions");
    const mergedCandidates = [...state.playbookCandidates, ...state.llmCandidates];
    const decision = decideActions(mergedCandidates, state.autonomyPolicy);
    return { mergedCandidates, decision };
  }

  async function guardrailCheck(state: AccountAnalysisStateType): Promise<AccountAnalysisUpdate> {
    logger.debug({ runId: state.runId }, "guardrail_check");
    const candidates = state.decision
      ? [...state.decision.autoApply, ...state.decision.needApproval]
      : state.mergedCandidates;
    const guardrail = applyGuardrails(candidates, state.guardrailConfig);
    return { guardrail };
  }

  async function createApprovalAndInterrupt(
    state: AccountAnalysisStateType,
  ): Promise<AccountAnalysisUpdate> {
    logger.debug({ runId: state.runId }, "create_approval + interrupt");
    const decision = interrupt({
      type: "approval_required",
      runId: state.runId,
      actions: state.decision?.needApproval ?? [],
    });
    return { approvedActions: (decision as { approvedActions?: never[] })?.approvedActions ?? [] };
  }

  async function applyActions(state: AccountAnalysisStateType): Promise<AccountAnalysisUpdate> {
    logger.debug({ runId: state.runId }, "apply_actions");
    return { results: [] };
  }

  async function notify(state: AccountAnalysisStateType): Promise<AccountAnalysisUpdate> {
    logger.debug({ runId: state.runId }, "notify");
    return {};
  }

  return {
    loadContext,
    fetchData,
    runPlaybook: runPlaybookNode,
    llmAnalyze,
    buildRecommendations,
    record,
    decideActions: decideActionsNode,
    guardrailCheck,
    createApprovalAndInterrupt,
    applyActions,
    notify,
  };
}

/** Busca entidades por nível (degrada em `partial` se um nível falhar). */
async function fetchEntities(
  ads: AdsPlatformPort,
  ref: { adAccountId: string; accessToken: string },
  logger: WorkerDeps["logger"],
): Promise<{ entities: AdEntity[]; entitiesPartial: boolean }> {
  const entities: AdEntity[] = [];
  let entitiesPartial = false;
  for (const level of SEGMENT_LEVELS) {
    try {
      entities.push(...(await ads.listEntities(ref, level)));
    } catch (error) {
      if (error instanceof AdsPlatformError && error.kind === "invalid_credential") throw error;
      entitiesPartial = true;
      logger.warn({ level, err: error }, "fetch_entities:nível degradou");
    }
  }
  return { entities, entitiesPartial };
}

/** Recomendação do LLM → linha persistível (ação tipada só quando aplicável + id real). */
function toRecommendationRow(
  rec: AnalysisRecommendation,
  orgId: string,
  runId: string,
  knownIds: ReadonlySet<string>,
): RecommendationRow {
  const actionType = applicableActionType(rec.actionType);
  const hasValidTarget = rec.targetEntity !== null && knownIds.has(rec.targetEntity.externalId);
  const proposedAction: Action | null =
    actionType && rec.targetEntity && hasValidTarget
      ? {
          id: rec.id,
          type: actionType,
          target: { level: rec.targetEntity.level, id: rec.targetEntity.externalId },
          params: budgetParams(rec),
          source: "llm",
          riskLevel: riskLevelForActionType(actionType),
          reason: rec.rationale,
        }
      : null;
  return {
    orgId,
    runId,
    title: rec.title,
    rationale: rec.rationale,
    proposedAction,
    riskLevel: actionType ? riskLevelForActionType(actionType) : "low",
  };
}

/** Params da ação de budget (direção + %), quando for o caso. */
function budgetParams(rec: AnalysisRecommendation): Record<string, unknown> {
  const dir = budgetDirection(rec.actionType);
  if (dir && typeof rec.budgetChangePct === "number") return { mode: dir, pct: rec.budgetChangePct };
  return {};
}

/**
 * Aresta condicional após o guardrail (write-half, 5a+): precisa de OK humano?
 */
export function routeApproval(state: AccountAnalysisStateType): "approval" | "apply" {
  const needs = state.decision?.needApproval.length ?? 0;
  return needs > 0 ? "approval" : "apply";
}
