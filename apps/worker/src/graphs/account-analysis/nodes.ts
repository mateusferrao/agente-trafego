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
  composeMethodologyPrompt,
  costSnapshotFromUsage,
  decideActions,
  dropUnsupportedFindings,
  evaluatePlaybook,
  flagUnsupportedFindings,
  riskLevelForActionType,
} from "@trafego/core";
import { funnelFromRawActions } from "@trafego/ads-meta";
import {
  analysisOutputSchema,
  ANALYSIS_OUTPUT_JSON_SCHEMA,
  ANALYSIS_OUTPUT_SCHEMA_NAME,
  type AnalysisOutput,
  type AnalysisRecommendation,
} from "@trafego/shared/schemas";
import type { Action, AdEntity, EntityLevel, Finding, InsightRow } from "@trafego/shared";
import type { AdsPlatformPort } from "@trafego/shared/ports";
import { AdsPlatformError, LLMProviderError } from "@trafego/shared/ports";
import type { WorkerDeps } from "../../composition.js";
import {
  createDrizzleInsightsSnapshotsRepo,
  type InsightsSnapshotsRepo,
} from "../../modules/insights/repo.js";
import { createAnalysisRepo, type AnalysisRepo, type RecommendationRow } from "../../modules/analysis/repo.js";
import { AnalysisError } from "../../modules/analysis/errors.js";
import { resolveAnalysisConfig } from "../../modules/analysis/config.js";
import { buildAnalysisMessages, buildReviewMessages } from "../../modules/analysis/prompt.js";
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

    // config resolvida por-agente (model_config) com fallback nos defaults globais.
    const cfg = resolveAnalysisConfig(ctx.modelConfig, deps.analysis);
    // system prompt = override do agente OU metodologia do arquétipo (dado → texto).
    const systemPrompt = ctx.systemPrompt ?? composeMethodologyPrompt(archetypeDefaults(ctx.archetype));
    const { window, baseline } = resolveWindows(today(), cfg.windowDays, cfg.baselineDays);
    const windowLabel = `últimos ${cfg.windowDays} dias`;
    const baselineLabel = `${cfg.baselineDays} dias anteriores`;

    await repo.openRun(state.orgId, state.runId, {
      goals: ctx.goals,
      model: cfg.model,
      reviewEnabled: cfg.reviewEnabled,
      window,
      baseline,
      topN: cfg.topN,
    });

    return {
      goals: ctx.goals,
      playbookRules: ctx.playbook,
      systemPrompt,
      analysisConfig: cfg,
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
    const rawInsights = await snapshots.listWindow(
      state.orgId,
      state.adAccountId,
      state.window.since,
      state.window.until,
    );
    // deriva o funil neutro do rawActions já persistido (vocabulário Meta só no adapter).
    const insights = rawInsights.map(withFunnel);
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

    const cfg = state.analysisConfig ?? deps.analysis;
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
      topN: cfg.topN,
    });

    // conta parada (ICP entre lançamentos) → não gasta LLM, run conclui com nota.
    if (built.status === "empty") {
      return { brief: null, analysisOutput: null, findings: [], summary: NO_ACTIVITY_SUMMARY };
    }

    const completion = await deps.ports.llm.completeStructured<AnalysisOutput>({
      model: cfg.model,
      messages: buildAnalysisMessages(state.systemPrompt, built.brief),
      responseSchema: ANALYSIS_OUTPUT_JSON_SCHEMA,
      responseSchemaName: ANALYSIS_OUTPUT_SCHEMA_NAME,
      temperature: ANALYSIS_TEMPERATURE,
      maxTokens: cfg.maxOutputTokens,
    });

    const parsed = analysisOutputSchema.safeParse(completion.output);
    if (!parsed.success) throw new AnalysisError("analysis_failed", "output do LLM fora do schema");

    return {
      brief: built.brief,
      analysisOutput: parsed.data,
      usage: addTokenUsage(state.usage ?? undefined, completion.usage),
    };
  }

  /**
   * Revisor (rede de segurança) + guards determinísticos. Fluxo:
   * pré-check (flag) → reviewPasses (LLM, refina; nunca inventa) → drop final.
   * Revisor falhou → cai pra saída do analista + marca parcial (§7). Extensível:
   * `reviewPasses` cresce p/ os painéis da Fatia 8.
   */
  async function reviewAnalysis(state: AccountAnalysisStateType): Promise<AccountAnalysisUpdate> {
    logger.debug({ runId: state.runId }, "review_analysis");
    if (!state.analysisOutput || !state.brief) return {}; // conta parada → nada a revisar
    const cfg = state.analysisConfig ?? deps.analysis;

    const draft = state.analysisOutput;
    let reviewed: AnalysisOutput = draft;
    let usage = state.usage;
    let partial = state.partial ?? false;

    if (cfg.reviewEnabled) {
      const issues = flagUnsupportedFindings(draft, state.brief);
      try {
        const completion = await deps.ports.llm.completeStructured<AnalysisOutput>({
          model: cfg.model,
          messages: buildReviewMessages(state.brief, draft, issues),
          responseSchema: ANALYSIS_OUTPUT_JSON_SCHEMA,
          responseSchemaName: ANALYSIS_OUTPUT_SCHEMA_NAME,
          temperature: ANALYSIS_TEMPERATURE,
          maxTokens: cfg.maxOutputTokens,
        });
        const parsed = analysisOutputSchema.safeParse(completion.output);
        if (parsed.success) {
          reviewed = parsed.data;
          usage = addTokenUsage(usage ?? undefined, completion.usage);
        } else {
          partial = true; // revisor devolveu fora do schema → usa o analista
          logger.warn({ runId: state.runId }, "review:output fora do schema; usando analista");
        }
      } catch (err) {
        if (!(err instanceof LLMProviderError)) throw err; // erro inesperado sobe
        partial = true; // revisor falhou → degradação graciosa (usa o analista)
        logger.warn({ runId: state.runId, err }, "review:falhou; usando análise sem revisão");
      }
    }

    // drop determinístico final (hard): remove finding sem métrica / número fora do brief.
    const final = dropUnsupportedFindings(reviewed, state.brief);
    const findings: Finding[] = final.findings.map((f) => ({
      title: f.title,
      detail: f.detail,
      severity: f.severity,
    }));
    return { analysisOutput: final, findings, summary: final.summary, usage, partial };
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

  /** Fecha o run (status, summary, partial, custo/usage, metrics_snapshot p/ o site). */
  async function record(state: AccountAnalysisStateType): Promise<AccountAnalysisUpdate> {
    logger.debug({ runId: state.runId }, "record");
    const usage = state.usage;
    await repo.closeRun(state.orgId, state.runId, {
      status: "succeeded",
      summary: state.summary ?? null,
      partial: state.partial ?? false,
      tokenUsage: usage ? { ...usage } : null,
      costSnapshot: usage ? costSnapshotFromUsage(usage) : null,
      metricsSnapshot: buildMetricsSnapshot(state),
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

  /** HOF: grava um `agent_run_step` (succeeded/failed + erro) ao redor do nó. DRY. */
  function step(
    name: string,
    fn: (s: AccountAnalysisStateType) => Promise<AccountAnalysisUpdate>,
  ): (s: AccountAnalysisStateType) => Promise<AccountAnalysisUpdate> {
    return async (state) => {
      try {
        const patch = await fn(state);
        await repo.recordStep({ runId: state.runId, name, status: "succeeded" });
        return patch;
      } catch (err) {
        await repo.recordStep({ runId: state.runId, name, status: "failed", error: String(err) });
        throw err;
      }
    };
  }

  return {
    loadContext: step("load_context", loadContext),
    fetchData: step("fetch_data", fetchData),
    runPlaybook: step("run_playbook", runPlaybookNode),
    llmAnalyze: step("llm_analyze", llmAnalyze),
    reviewAnalysis: step("review_analysis", reviewAnalysis),
    buildRecommendations: step("build_recommendations", buildRecommendations),
    record: step("record", record),
    // write-half (scaffold — 3b/4/5a/5b): sem step por ora.
    decideActions: decideActionsNode,
    guardrailCheck,
    createApprovalAndInterrupt,
    applyActions,
    notify,
  };
}

/** Enriquece a linha com o funil neutro derivado do rawActions (adapter mapper). */
function withFunnel(row: InsightRow): InsightRow {
  const funnel = funnelFromRawActions(row.rawActions);
  return funnel.length > 0 ? { ...row, funnel } : row;
}

/** KPIs + funil + scorecard congelados p/ o site (null em conta parada). */
function buildMetricsSnapshot(state: AccountAnalysisStateType): Record<string, unknown> | null {
  if (!state.brief) return null;
  const t = state.brief.totals;
  return {
    kpis: {
      spend: t.spend,
      impressions: t.impressions,
      clicks: t.clicks,
      ctr: t.ctr,
      ...(t.cpa !== undefined ? { cpa: t.cpa } : {}),
      ...(t.roas !== undefined ? { roas: t.roas } : {}),
    },
    ...(state.brief.funnel ? { funnel: state.brief.funnel } : {}),
    ...(state.analysisOutput?.scorecard ? { scorecard: state.analysisOutput.scorecard } : {}),
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
