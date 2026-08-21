// Nós FINOS do grafo `account-analysis`: só IO + orquestração. Toda regra vive
// nas funções puras de `@trafego/core` (playbook/guardrails/decision/brief),
// testadas sem mock. Cada nó retorna um patch parcial do estado.
//
// 3a = rota READ-ONLY: load_context → fetch_data → run_playbook → llm_analyze →
// build_recommendations → record. A metade de escrita (decide/guardrail/approval/
// apply/notify) fica scaffolded p/ 3b/4/5a/5b.

import {
  addTokenUsage,
  applicableActionType,
  applyGuardrails,
  archetypeDefaults,
  budgetDirection,
  buildAccountBrief,
  buildEntityConversionMap,
  buildMessageFallback,
  composeAgentPrompt,
  composeMethodologyPrompt,
  costSnapshotFromUsage,
  creativePosterFrames,
  decideActions,
  dropUnsupportedFindings,
  eligibilityByEntity,
  guardScaleWithoutSignificance,
  guardKillWithoutMaturity,
  guardTrackingCaveat,
  basisByEntity,
  annotateFreedSpend,
  evaluatePlaybook,
  flagUnsupportedFindings,
  entityKeyOf,
  mergeUnitAnalyses,
  resolveActionConflicts,
  riskForAction,
  selectCampaignsToAnalyze,
  selectCreatives,
  targetStatusOf,
  type LastUnit,
} from "@trafego/core";
import { ACTION_PARAM_MODE, ACTION_PARAM_PCT, APPROVAL_TTL_HOURS } from "@trafego/shared";
import { funnelFromRawActions, mapStatus } from "@trafego/ads-meta";
import {
  analysisOutputSchema,
  ANALYSIS_OUTPUT_JSON_SCHEMA,
  ANALYSIS_OUTPUT_SCHEMA_NAME,
  unitAnalysisSchema,
  UNIT_ANALYSIS_JSON_SCHEMA,
  UNIT_ANALYSIS_SCHEMA_NAME,
  type AnalysisOutput,
  type AnalysisRecommendation,
  type UnitAnalysis,
} from "@trafego/shared/schemas";
import type {
  Action,
  ActionTarget,
  AdEntity,
  AudienceStage,
  CampaignUnit,
  AgentId,
  Creative,
  CreativeVisionResult,
  EntityLevel,
  EntityStatus,
  EntitySummary,
  Finding,
  InsightMetrics,
  InsightRow,
  OrgId,
  RunCampaignCard,
  RunId,
} from "@trafego/shared";
import type { AdsPlatformPort, CreativeVisionPort, MutationResult } from "@trafego/shared/ports";
import { AdsPlatformError, LLMProviderError } from "@trafego/shared/ports";
import type { WorkerDeps } from "../../composition.js";
import {
  createDrizzleInsightsSnapshotsRepo,
  type InsightsSnapshotsRepo,
} from "../../modules/insights/repo.js";
import {
  createAnalysisRepo,
  type AnalysisRepo,
  type ConversionLabelRow,
  type RecommendationRow,
} from "../../modules/analysis/repo.js";
import {
  createEntityAnalysesRepo,
  type EntityAnalysesRepo,
  type LastEntityAnalysis,
} from "../../modules/analysis/entity-analyses.repo.js";
import { createNotifyRepo, type NotifyRepo } from "../../modules/notify/repo.js";
import { createSendToContact } from "../../modules/notify/send-to-contact.js";
import { createVisionResolver, creativeContentHash } from "../../modules/vision/resolver.js";
import { makeMetaToolExecutor, type MetaToolExecutor } from "../../executors/meta-tools.js";
import { AnalysisError } from "../../modules/analysis/errors.js";
import { mapWithConcurrency } from "../../lib/concurrency.js";
import { resolveAnalysisConfig } from "../../modules/analysis/config.js";
import {
  buildCampaignMessages,
  buildReviewMessages,
  buildSynthesisMessages,
} from "../../modules/analysis/prompt.js";
import {
  buildMessageMessages,
  MESSAGE_OUTPUT_JSON_SCHEMA,
  MESSAGE_OUTPUT_SCHEMA_NAME,
} from "../../modules/notify/prompt.js";
import { resolveWindows } from "@trafego/core";
import type { AccountAnalysisStateType, AccountAnalysisUpdate } from "./state.js";

/** Nº de dias sem análise que dispara um run DEEP (reanalisa tudo). */
const DAY_MS = 24 * 60 * 60 * 1000;

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
  readonly notify: NotifyRepo;
  readonly entityAnalyses: EntityAnalysesRepo;
  /** resolver de visão — injetável p/ teste; default cria por-run (com meta). */
  readonly vision?: CreativeVisionPort;
  /** executor de escrita — injetável p/ teste; default = Meta via ports. */
  readonly executor?: MetaToolExecutor;
}

/** Fábrica de nós com deps injetadas (composition root passa `deps`). */
export function makeAccountAnalysisNodes(deps: WorkerDeps, repos?: Partial<AnalysisNodeRepos>) {
  const { logger } = deps;
  const repo = repos?.repo ?? createAnalysisRepo(deps.db);
  const snapshots = repos?.snapshots ?? createDrizzleInsightsSnapshotsRepo(deps.db);
  const notifyRepo = repos?.notify ?? createNotifyRepo(deps.db);
  const entityAnalysesRepo = repos?.entityAnalyses ?? createEntityAnalysesRepo(deps.db);
  const executor = repos?.executor ?? makeMetaToolExecutor(deps);
  const sendToContact = createSendToContact({ messaging: deps.ports.messaging, repo: notifyRepo });

  /** Carrega agent/config/janela e abre o run (status=running, snapshot congelado). */
  async function loadContext(state: AccountAnalysisStateType): Promise<AccountAnalysisUpdate> {
    logger.debug({ runId: state.runId }, "load_context");
    const ctx = await repo.loadAgentContext(state.orgId, state.agentId);
    if (!ctx) throw new AnalysisError("agent_missing", "agente não encontrado");

    // config resolvida por-agente (model_config) com fallback nos defaults globais.
    const cfg = resolveAnalysisConfig(ctx.modelConfig, deps.analysis);
    // system prompt = base (override do agente OU metodologia do arquétipo) +
    // identidade/voz (persona/tom) + camada ADITIVA de personalização (contexto +
    // orientações) — Fatia 4. persona/tom entram como diretiva de voz, sobre a base.
    const methodologyBase = ctx.systemPrompt ?? composeMethodologyPrompt(archetypeDefaults(ctx.archetype));
    const identity = [
      ctx.persona ? `Persona: ${ctx.persona}` : "",
      ctx.tone ? `Tom da comunicação: ${ctx.tone}` : "",
    ]
      .filter((s) => s.length > 0)
      .join("\n");
    const basePrompt = identity ? `${methodologyBase}\n\n${identity}` : methodologyBase;
    const systemPrompt = composeAgentPrompt(basePrompt, {
      ...(ctx.businessContext ? { businessContext: ctx.businessContext } : {}),
      ...(ctx.guidance ? { guidance: ctx.guidance } : {}),
    });
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
      autonomyPolicy: ctx.autonomyPolicy,
      guardrailConfig: ctx.guardrailConfig,
      rejectedMemory: ctx.rejectedMemory,
      mutedCampaignIds: ctx.mutedCampaignIds,
      systemPrompt,
      configChangedAt: ctx.configChangedAt ? ctx.configChangedAt.getTime() : null,
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
    // persiste os rótulos de conversão resolvidos (id→nome) p/ a config ler do banco
    // sem falar com a plataforma (Fatia 4). Genérico: platform como coluna.
    await repo.saveConversionLabels(state.orgId, state.adAccountId, ADS_PLATFORM, collectConversionLabels(entities));
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

    // criativos dos anúncios (p/ visão no map — 3b-2). Degrada em `partial` se falhar.
    const adIds = entities.filter((e) => e.level === "ad").map((e) => e.id);
    let creatives: Creative[] = [];
    let creativesPartial = false;
    if (adIds.length > 0) {
      try {
        creatives = await deps.ports.ads.getCreatives(ref, adIds);
      } catch (error) {
        creativesPartial = true;
        logger.warn({ err: error }, "fetch_data:getCreatives degradou (segue sem visão)");
      }
    }

    return {
      account: {
        metaAdAccountId: account.metaAdAccountId,
        name: account.name,
        currency: account.currency,
      },
      entities,
      insights,
      baselineInsights,
      creatives,
      partial: sync.partial || entitiesPartial || creativesPartial,
    };
  }

  /** Regras determinísticas → ações-base (funções puras do core). */
  async function runPlaybookNode(state: AccountAnalysisStateType): Promise<AccountAnalysisUpdate> {
    logger.debug({ runId: state.runId }, "run_playbook");
    // resolução da conversão de negócio por entidade → CPA/ROAS das regras seguem o
    // basis (só disparam onde a conversão é mensurável). Mesma fonte do brief (§7).
    const resolution = buildEntityConversionMap(state.insights, state.entities, state.goals);
    const playbookCandidates = evaluatePlaybook(state.playbookRules, state.insights, resolution);
    return { playbookCandidates };
  }

  /**
   * MAPA (map-reduce): curadoria (AccountBrief) + análise POR-CAMPANHA ativa.
   * `selectCampaignsToAnalyze` corta pro top-N (flagadas sempre) e aplica a política
   * (deep/incremental); o resto herda `entity_analyses` ou fica resumido no brief.
   * Cada campanha é analisada como árvore curada (adsets + anúncios notáveis) + a
   * visão dos criativos notáveis (teto POR campanha). Campanha que falha é pulada
   * (partial), não aborta o run.
   */
  async function mapUnits(state: AccountAnalysisStateType): Promise<AccountAnalysisUpdate> {
    logger.debug({ runId: state.runId }, "map_units");
    if (!state.account || !state.window || !state.baseline) {
      throw new AnalysisError("analysis_failed", "contexto incompleto");
    }
    const cfg = state.analysisConfig ?? deps.analysis;
    const built = buildAccountBrief({
      account: { id: state.account.metaAdAccountId, name: state.account.name, currency: state.account.currency },
      window: state.window.label,
      baselineWindow: state.baseline.label,
      goals: state.goals,
      entities: state.entities,
      rows: state.insights,
      baselineRows: state.baselineInsights,
      playbookCandidates: state.playbookCandidates,
      topN: cfg.topN,
      notableAdsPerCampaign: cfg.notableAdsPerCampaign,
      qualityThresholds: cfg.quality,
      ...(state.mutedCampaignIds ? { mutedCampaignIds: new Set(state.mutedCampaignIds) } : {}),
      memory: { objectives: [], pastActions: [], rejected: [...(state.rejectedMemory ?? [])] },
    });
    if (built.status === "empty") {
      return { brief: null, analysisOutput: null, findings: [], summary: NO_ACTIVITY_SUMMARY, unitAnalyses: [], freshUnits: [], campaignCards: [] };
    }

    const last = await entityAnalysesRepo.loadByAgent(state.agentId);
    const lastUnits = new Map<string, LastUnit>(
      [...last].map(([id, r]) => [id, { metrics: r.metrics, flags: r.flags }]),
    );
    const campaignSummaries = built.campaignUnits.map((u) => u.campaign);
    const isDeepRun = decideDeepRun(state.trigger, campaignSummaries, last, cfg.deepIntervalDays, state.configChangedAt);
    const selection = selectCampaignsToAnalyze(built.campaignUnits, lastUnits, {
      policy: cfg.executionPolicy,
      materialChangePct: cfg.materialChangePct,
      isDeepRun,
      topN: cfg.topN,
      ...(cfg.executionPolicy === "budget_scaled" ? { maxUnitsThisRun: Math.max(cfg.topN, 1) } : {}),
    });
    logger.debug(
      { runId: state.runId, analyze: selection.toAnalyze.length, inherit: selection.toInherit.length, summarized: selection.summarized.length },
      "map_units:seleção por campanha",
    );

    const creativesByAdId = groupBy(state.creatives ?? [], (c) => c.adId);
    const vision = repos?.vision ?? createVisionResolver({
      db: deps.db,
      llm: deps.ports.llm,
      model: cfg.visionModel,
      analyzerVersion: deps.visionAnalyzerVersion,
      logger,
      meta: { orgId: state.orgId, runId: state.runId },
    });

    // MAP paralelo: até `mapConcurrency` campanhas ao mesmo tempo (o gargalo do run).
    // Cada task é independente e RETORNA seu resultado; a redução (usage/partial/
    // listas) acontece depois do pool — sem race nos acumuladores.
    type FreshUnit = AccountAnalysisStateType["freshUnits"][number];
    // captura os valores já garantidos (guard no topo) — o narrowing não cruza o closure.
    const accountCurrency = state.account.currency;
    const windowLabel = state.window.label;
    const businessGoal = state.goals.conversionGoal;
    const outcomes = await mapWithConcurrency(selection.toAnalyze, cfg.mapConcurrency, async (unit) => {
      // visão dos criativos dos anúncios notáveis DESTA campanha (teto por campanha).
      const notableAdIds = unit.adsets.flatMap((g) => g.notableAds.map((a) => a.id));
      const chosenCreatives = selectCreatives(notableAdIds, creativesByAdId, cfg.maxCreativesVisionPerCampaign);
      const visionByAdId = new Map<string, CreativeVisionResult[]>();
      for (const c of chosenCreatives) {
        const frames = creativePosterFrames(c);
        if (frames.length === 0) continue;
        const copy = creativeCopy(c);
        // chave de cache ESTÁVEL (id do criativo + vídeo), não a URL do fbcdn (rotaciona).
        const stableKey = `${c.id}:${c.videoId ?? ""}`;
        const result = await vision.resolve({
          creativeId: c.id,
          imageUrls: frames,
          contentHash: creativeContentHash(stableKey, copy),
          ...(copy ? { copy } : {}),
        });
        if (result) push(visionByAdId, c.adId, result);
      }

      try {
        const completion = await deps.ports.llm.completeStructured<UnitAnalysis>({
          model: cfg.unitModel,
          messages: buildCampaignMessages(state.systemPrompt, unit, visionByAdId, {
            currency: accountCurrency,
            window: windowLabel,
            ...(businessGoal ? { businessGoal } : {}),
          }),
          responseSchema: UNIT_ANALYSIS_JSON_SCHEMA,
          responseSchemaName: UNIT_ANALYSIS_SCHEMA_NAME,
          temperature: ANALYSIS_TEMPERATURE,
          maxTokens: cfg.maxOutputTokens,
          reasoning: { effort: cfg.reasoningEffort },
          meta: { orgId: state.orgId, runId: state.runId, type: "unit" },
        });
        const parsed = unitAnalysisSchema.safeParse(completion.output);
        if (!parsed.success) return { unit: null, fresh: null, usage: completion.usage, partial: true };
        const fresh: FreshUnit = {
          entityId: unit.campaign.id,
          entityLevel: "campaign",
          entityName: unit.campaign.name,
          unit: parsed.data,
          metrics: unit.campaign.metrics,
          flags: [...unit.campaign.flags],
          ...(unit.campaign.tier ? { tier: unit.campaign.tier } : {}),
        };
        return { unit: parsed.data, fresh, usage: completion.usage, partial: false };
      } catch (err) {
        if (!(err instanceof LLMProviderError)) throw err;
        logger.warn({ runId: state.runId, campaign: unit.campaign.id, err }, "map_units:campanha falhou");
        return { unit: null, fresh: null, usage: null, partial: true };
      }
    });

    // REDUÇÃO (sequencial, sem race): soma usage, agrega parcial, coleta unidades.
    const unitAnalyses: UnitAnalysis[] = [];
    const freshUnits: FreshUnit[] = [];
    let usage = state.usage;
    let partial = state.partial ?? false;
    for (const o of outcomes) {
      if (o.usage) usage = addTokenUsage(usage ?? undefined, o.usage);
      if (o.partial) partial = true;
      if (o.unit) unitAnalyses.push(o.unit);
      if (o.fresh) freshUnits.push(o.fresh);
    }
    // herança: campanhas sem mudança material reusam a última análise.
    for (const unit of selection.toInherit) {
      const inherited = last.get(unit.campaign.id);
      if (inherited) unitAnalyses.push(inherited.unit);
    }

    // cartões por-campanha congelados p/ o histórico (fresh + herdadas). O snapshot
    // é do run; o entity_analyses (upsertado) só guarda a última — daí congelar aqui.
    const freshUnitById = new Map<string, UnitAnalysis>(freshUnits.map((f) => [f.entityId, f.unit]));
    const campaignCards = buildCampaignCards(built.campaignUnits, freshUnitById, last);

    return { brief: built.brief, unitAnalyses, freshUnits, campaignCards, usage, partial };
  }

  /**
   * REDUÇÃO (síntese): consolida as análises por-anúncio + o contexto da conta num
   * diagnóstico único (modelo forte). Fallback determinístico se o LLM falhar.
   */
  async function synthesize(state: AccountAnalysisStateType): Promise<AccountAnalysisUpdate> {
    logger.debug({ runId: state.runId }, "synthesize");
    if (!state.brief) return {}; // conta parada → nada a sintetizar
    const cfg = state.analysisConfig ?? deps.analysis;
    const units = state.unitAnalyses ?? [];

    let output: AnalysisOutput | null = null;
    let usage = state.usage;
    let partial = state.partial ?? false;
    try {
      const completion = await deps.ports.llm.completeStructured<AnalysisOutput>({
        model: cfg.model,
        messages: buildSynthesisMessages(state.systemPrompt, state.brief, units),
        responseSchema: ANALYSIS_OUTPUT_JSON_SCHEMA,
        responseSchemaName: ANALYSIS_OUTPUT_SCHEMA_NAME,
        temperature: ANALYSIS_TEMPERATURE,
        maxTokens: cfg.maxOutputTokens,
        reasoning: { effort: cfg.reasoningEffort },
        meta: { orgId: state.orgId, runId: state.runId, type: "synthesis" },
      });
      usage = addTokenUsage(usage ?? undefined, completion.usage);
      const parsed = analysisOutputSchema.safeParse(completion.output);
      if (parsed.success) output = parsed.data;
      else partial = true;
    } catch (err) {
      if (!(err instanceof LLMProviderError)) throw err;
      partial = true;
      logger.warn({ runId: state.runId, err }, "synthesize:falhou; consolidação determinística");
    }
    // fallback determinístico (merge das unidades) — nunca deixa o run sem saída.
    if (!output) output = mergeUnitAnalyses(units);
    return { analysisOutput: output, usage, partial };
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
          reasoning: { effort: cfg.reasoningEffort },
          // D1 (6c): emite usage_event `review` (antes a chamada não passava meta).
          meta: { orgId: state.orgId, runId: state.runId, type: "review" },
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
    const dropped = dropUnsupportedFindings(reviewed, state.brief);
    // guard de significância (6c): rebaixa escalar sem base → investigar (rede final,
    // roda ANTES de decide_actions → vale também pro caminho autônomo 5a).
    const eligibility = eligibilityByEntity(state.brief);
    const scaled = guardScaleWithoutSignificance(dropped, eligibility);
    // não-matar-em-learning (Bloco 2): rebaixa pausar → investigar em entidade nova
    // (não descarta o aprendizado). LLM-origin; playbook/guardrail não passam por aqui.
    const guarded = guardKillWithoutMaturity(scaled, eligibility);
    // guard de tracking (Bloco 2): caveat nas pausas por CPA de venda quando a
    // medição da conta parece incompleta (não rebaixa; só anexa ao rationale).
    const caveated = guardTrackingCaveat(guarded, basisByEntity(state.brief), state.brief.trackingHealth);
    // impacto (Bloco 2): anexa o gasto liberado a cada recomendação de pausa.
    const spendById = new Map<string, number>();
    for (const level of [state.brief.segments.campaigns, state.brief.segments.adsets, state.brief.segments.ads]) {
      for (const e of level) spendById.set(e.id, e.metrics.spend ?? 0);
    }
    const final = annotateFreedSpend(caveated, spendById);
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
    // ações propostas pelo LLM (com alvo válido) → candidatas do caminho de escrita.
    const llmCandidates = rows.map((r) => r.proposedAction).filter((a): a is Action => a !== null);
    return { llmCandidates };
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
    // persiste as análises por-unidade REANALISADAS (base do incremental/herança).
    await entityAnalysesRepo.saveMany(state.agentId, state.runId, state.freshUnits ?? []);
    // consome o marcador de config (one-shot): este run já aplicou a nova config
    // num deep; sem isso, contas com mais campanhas que o top-N ficariam em deep
    // permanente (o analyzedAt só avança nas reanalisadas).
    if (state.configChangedAt != null) {
      await repo.consumeConfigChanged(state.orgId, state.agentId, new Date(state.configChangedAt));
    }
    return {};
  }

  // ── metade de escrita (5a — auto-apply only; HITL/interrupt = 5b) ──────
  /** Dedupe + conflito (pausar domina) → decisão de autonomia por origem. */
  async function decideActionsNode(
    state: AccountAnalysisStateType,
  ): Promise<AccountAnalysisUpdate> {
    logger.debug({ runId: state.runId }, "decide_actions");
    // rótulo legível vem do catálogo cru (`state.entities`, todos os status) — cobre
    // entidades pausadas que nunca passam pelo mapa/LLM (não têm `entity_analyses`).
    const nameById = new Map((state.entities ?? []).map((e) => [e.id, e.name]));
    const merged = [...(state.playbookCandidates ?? []), ...(state.llmCandidates ?? [])].map((a) => {
      const name = nameById.get(a.target.id);
      // `name` opcional (exactOptionalPropertyTypes): só inclui quando conhecido.
      return name !== undefined ? { ...a, target: { ...a.target, name } } : a;
    });
    const { kept, dropped } = resolveActionConflicts(merged);
    if (dropped.length > 0) logger.debug({ runId: state.runId, dropped: dropped.length }, "decide:conflitos resolvidos");
    const decision = decideActions(kept, state.autonomyPolicy);
    return { mergedCandidates: kept, decision };
  }

  /**
   * Guardrail (rede cross-run + budget-level + no-op) sobre AMBOS os caminhos:
   * `autoApply` (vira escrita em apply_actions) e `needApproval` (vira `approvals`).
   * Rodar nas sugeridas fecha o gap: ação não-permitida/no-op nunca chega a pedir OK.
   * As `dropped` dos dois viram "barradas" (visíveis). (Fast-follow: relaxar os
   * throttles de ritmo — cap/anti-compounding — no caminho de sugestão.)
   */
  async function guardrailCheck(state: AccountAnalysisStateType): Promise<AccountAnalysisUpdate> {
    logger.debug({ runId: state.runId }, "guardrail_check");
    const daily = await repo.loadDailyToolContext(state.agentId);
    const budgetByEntity = buildBudgetByEntity(state.entities);
    let statusByEntity = buildStatusByEntity(state.entities);

    // Releitura pontual (5b): `state.entities` vem do catálogo CACHEADO (MetaEntityCache,
    // TTL — só invalida na escrita REAL pelo nosso sistema). Uma mudança feita direto no
    // Ads Manager não invalida o cache, então o no-op pode confiar num status velho —
    // nas DUAS direções (barrar à toa OU deixar passar uma sugestão já desnecessária,
    // ex: "retomar" o que já está ativo). Relê TODAS as entidades-alvo de candidatas de
    // status (normalmente 0-3/run) — não reintroduz a pressão de rate-limit que o cache
    // existe pra evitar.
    const allCandidates = [...(state.decision?.autoApply ?? []), ...(state.decision?.needApproval ?? [])];
    const targets = statusChangeTargets(allCandidates);
    if (targets.size > 0) {
      statusByEntity = await refreshStatusByEntity(
        { repo, ads: deps.ports.ads, vault: deps.ports.vault, logger },
        state,
        targets,
        statusByEntity,
      );
    }

    const ctx = { touchedToday: daily.touchedToday, budgetChangedToday: daily.budgetChangedToday, budgetByEntity, statusByEntity };
    const auto = applyGuardrails(state.decision?.autoApply ?? [], state.guardrailConfig, ctx);
    const pending = applyGuardrails(state.decision?.needApproval ?? [], state.guardrailConfig, ctx);
    const dropped = [...auto.dropped, ...pending.dropped];
    if (dropped.length > 0) logger.info({ runId: state.runId, dropped: dropped.length }, "guardrail:ações barradas");
    return { guardrail: auto, approvalCandidates: pending.allowed, droppedActions: dropped };
  }

  /**
   * Persiste as sugeridas (que passaram no guardrail) como `approvals` pendentes —
   * fonte da verdade acionável (mini-surface + /approvals). Upsert por (agente+entidade
   * +tipo): reincidência renova; não-tocadas expiram em 24h (job). O run NÃO trava
   * (fecha normal); o re-check fresco no apply é a rede final. Sem checkpointer (5b site).
   */
  async function createApprovals(state: AccountAnalysisStateType): Promise<AccountAnalysisUpdate> {
    logger.debug({ runId: state.runId }, "create_approvals");
    const candidates = state.approvalCandidates ?? [];
    if (candidates.length === 0) return {};
    const expiresAt = new Date(Date.now() + APPROVAL_TTL_HOURS * 3_600_000);
    for (const action of candidates) {
      await deps.ports.approval.upsertPending({
        orgId: state.orgId as OrgId,
        agentId: state.agentId as AgentId,
        runId: state.runId as RunId,
        action,
        expiresAt,
      });
    }
    logger.info({ runId: state.runId, pending: candidates.length }, "create_approvals:pendentes");
    return {};
  }

  /**
   * Aplica (ou SIMULA, se dry_run) as ações liberadas pelo guardrail, via executor
   * (idempotente + auditado). Best-effort por ação; PARA no rate_limited (não martela
   * o governor). needApproval NÃO executa (fica como sugestão — 5b resolve).
   */
  async function applyActions(state: AccountAnalysisStateType): Promise<AccountAnalysisUpdate> {
    logger.debug({ runId: state.runId }, "apply_actions");
    const toApply = state.guardrail?.allowed ?? [];
    if (toApply.length === 0) return { results: [] };

    const account = await repo.loadAccount(state.orgId, state.adAccountId);
    if (!account) return { results: [] };
    const accessToken = deps.ports.vault.decrypt(account.tokenCripto);
    const ref = { adAccountId: account.metaAdAccountId, accessToken };
    const dryRun = state.guardrailConfig.dryRun;

    const results: MutationResult[] = [];
    let hadFailure = false;
    for (const action of toApply) {
      try {
        const done = await executor.execute({
          agentId: state.agentId,
          runId: state.runId,
          orgId: state.orgId,
          account: ref,
          action,
          idempotencyKey: idempotencyKeyFor(state.runId, action),
          dryRun,
        });
        results.push(done.result);
      } catch (err) {
        hadFailure = true;
        // para no rate_limited (não insiste contra o governor); demais = best-effort.
        if (err instanceof AdsPlatformError && err.kind === "rate_limited") {
          logger.warn({ runId: state.runId, err }, "apply:rate-limit — interrompe o lote");
          break;
        }
        logger.warn({ runId: state.runId, action: action.type, err }, "apply:ação falhou (best-effort)");
      }
    }
    // falha/rate-limit no lote → marca parcial (o site/nota mostram que não fez tudo).
    return hadFailure ? { results, partial: true } : { results };
  }

  /**
   * Redator (papel dedicado) — redige a mensagem do WhatsApp a partir do resultado
   * curado. Só p/ cron (push) e quando há algo acionável; senão silêncio (decisão 4).
   * LLM barato + persona; fallback determinístico do core em erro/JSON.
   */
  async function writeMessage(state: AccountAnalysisStateType): Promise<AccountAnalysisUpdate> {
    logger.debug({ runId: state.runId }, "write_message");
    const isWhatsapp = state.notifyTarget != null; // run disparado pelo WhatsApp → responde na conversa
    if (state.trigger !== "cron" && !isWhatsapp) return { outboundMessage: null }; // on-demand no site
    const out = state.analysisOutput;
    if (!out || !state.account) return { outboundMessage: null };
    const hasRecs = out.recommendations.length > 0;
    // cron sem recomendação = silêncio; WhatsApp SEMPRE responde (o usuário pediu "analisa agora").
    if (!hasRecs && !isWhatsapp) return { outboundMessage: null };

    const cfg = state.analysisConfig ?? deps.analysis;
    let text: string | null = null;
    let usage = state.usage;
    if (hasRecs) {
      try {
        const completion = await deps.ports.llm.completeStructured<{ text: string }>({
          model: cfg.messageModel,
          messages: buildMessageMessages(state.systemPrompt, state.account.name, out, {
            ...(state.brief?.waste ? { waste: state.brief.waste } : {}),
            ...(state.brief?.trackingHealth?.suspect ? { trackingSuspect: true } : {}),
          }),
          responseSchema: MESSAGE_OUTPUT_JSON_SCHEMA,
          responseSchemaName: MESSAGE_OUTPUT_SCHEMA_NAME,
          temperature: ANALYSIS_TEMPERATURE,
          maxTokens: cfg.maxOutputTokens,
          meta: { orgId: state.orgId, runId: state.runId, type: "message" },
        });
        const t = completion.output?.text;
        if (typeof t === "string" && t.trim().length > 0) {
          text = t.trim();
          usage = addTokenUsage(usage ?? undefined, completion.usage);
        }
      } catch (err) {
        if (!(err instanceof LLMProviderError)) throw err;
        logger.warn({ runId: state.runId, err }, "write_message:redator falhou; usando fallback");
      }
      if (!text) {
        text = buildMessageFallback({
          accountName: state.account.name,
          ...(out.scorecard?.headline ? { headline: out.scorecard.headline } : {}),
          summary: out.summary,
          recommendations: out.recommendations.map((r) => ({ title: r.title })),
          ...(state.brief?.waste && state.brief.waste.wastedSpend > 0
            ? { money: { wastedSpend: state.brief.waste.wastedSpend, wastedPct: state.brief.waste.wastedPct } }
            : {}),
        });
      }
    } else {
      // WhatsApp pediu análise e não há recomendação → resposta honesta e curta (nunca silêncio).
      const headline = out.scorecard?.headline ?? out.summary;
      text = `Analisei a conta ${state.account.name}. ${headline} Nada crítico pra mexer agora — sigo de olho.`;
    }
    // nota honesta do que o agente FEZ neste run (aplicou/simulou) — determinística.
    const attempted = state.guardrail?.allowed.length ?? 0;
    const applied = appliedSummary(state.results?.length ?? 0, attempted, state.guardrailConfig.dryRun);
    if (applied) text = `${text}\n\n${applied}`;
    // bridge do HITL via site (5b corte 1): avisa que há pendentes + linka o site (o
    // link vem no nó notify). Aprovação pelo WhatsApp = corte 2.
    const pending = state.approvalCandidates?.length ?? 0;
    if (pending > 0) {
      // bridge do HITL (5b-2): dá pra aprovar respondendo por aqui OU pelo site.
      text = `${text}\n\n🔔 ${pending} ação(ões) aguardando seu OK. Responda por aqui pra aprovar/rejeitar, ou veja no site.`;
    }
    return { outboundMessage: text, usage };
  }

  /**
   * Push no WhatsApp. Cron → destinatário verificado da org (1 msg, enxuto).
   * WhatsApp-origin ("analisa agora") → o contato que pediu, na conversa (quebra em
   * blocos). Idempotente por run; degrada se a instância caiu (o run já foi fechado).
   */
  async function notify(state: AccountAnalysisStateType): Promise<AccountAnalysisUpdate> {
    logger.debug({ runId: state.runId }, "notify");
    const body = state.outboundMessage;
    if (!body) return {}; // nada acionável / não-cron sem push → silêncio
    if (await notifyRepo.alreadyNotified(state.runId)) return {}; // idempotência de envio

    // alvo: WhatsApp-origin → quem pediu; cron → destinatário verificado da org.
    let contactId = state.notifyTarget?.contactId ?? null;
    if (!contactId) {
      const target = await notifyRepo.loadTarget(state.orgId);
      contactId = target?.contactId ?? null;
    }
    if (!contactId) {
      logger.warn({ orgId: state.orgId, runId: state.runId }, "notify:sem canal/contato — sem push");
      return {};
    }

    const link = `${deps.webOrigin}/accounts/${state.adAccountId}`;
    const text = `${body}\n\nVer no site: ${link}`;
    // chat (push do WhatsApp) quebra em blocos; cron enxuto (1 msg) — ban-safety §9.
    const sent = await sendToContact(contactId, text, {
      split: state.notifyTarget != null,
      meta: { runId: state.runId },
    });
    if (!sent) logger.warn({ runId: state.runId }, "notify:envio falhou/sem instância — sem push");
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
    mapUnits: step("map_units", mapUnits),
    synthesize: step("synthesize", synthesize),
    reviewAnalysis: step("review_analysis", reviewAnalysis),
    buildRecommendations: step("build_recommendations", buildRecommendations),
    writeMessage: step("write_message", writeMessage),
    record: step("record", record),
    notify: step("notify", notify),
    // metade de escrita (5a) — auditada como os demais nós.
    decideActions: step("decide_actions", decideActionsNode),
    guardrailCheck: step("guardrail_check", guardrailCheck),
    applyActions: step("apply_actions", applyActions),
    createApprovals: step("create_approvals", createApprovals),
  };
}

/**
 * DEEP run? (reanalisa tudo, ignora incremental). Decidido na casca (relógio):
 *  - on_demand (usuário pediu) → sempre deep;
 *  - sem histórico (1º run) → deep;
 *  - config relevante à análise mudou depois de alguma análise vigente → deep (a
 *    herança incremental só olha métricas/flags, não a config; sem isso, editar
 *    conversão/contexto/orientações só refletiria quando uma métrica mexesse);
 *  - a análise mais antiga entre as unidades atuais passou do intervalo → deep.
 * `analyzedAt` só avança em reanálise real (não no inherit) → o deep dispara sozinho.
 */
function decideDeepRun(
  trigger: AccountAnalysisStateType["trigger"],
  adUnits: readonly EntitySummary[],
  last: ReadonlyMap<string, LastEntityAnalysis>,
  deepIntervalDays: number,
  configChangedAt: number | null,
): boolean {
  if (trigger === "on_demand") return true;
  if (last.size === 0) return true;
  if (configChangedAt !== null) {
    for (const u of adUnits) {
      const l = last.get(u.id);
      if (l && l.analyzedAt.getTime() < configChangedAt) return true; // análise anterior à mudança de config
    }
  }
  const thresholdMs = deepIntervalDays * DAY_MS;
  const now = Date.now();
  for (const u of adUnits) {
    const l = last.get(u.id);
    if (l && now - l.analyzedAt.getTime() > thresholdMs) return true;
  }
  return false;
}

/** Plataforma de ads deste grafo (Meta no MVP) — rótulo genérico p/ conversion_labels. */
const ADS_PLATFORM = "meta";

/**
 * Coleta os rótulos legíveis de conversão das entidades (id→nome resolvido pelo
 * adapter em `objective.label`, ex: conversões personalizadas). Dedupe por
 * (goal, id). Só entidades COM label entram (padrão sem label = rótulo no web).
 */
function collectConversionLabels(entities: readonly AdEntity[]): ConversionLabelRow[] {
  const byKey = new Map<string, ConversionLabelRow>();
  for (const e of entities) {
    const o = e.objective;
    if (!o?.label) continue;
    const customConversionId = o.customConversionId ?? "";
    const key = `${o.goal}:${customConversionId}`;
    if (!byKey.has(key)) byKey.set(key, { goal: o.goal, customConversionId, label: o.label });
  }
  return [...byKey.values()];
}

/** Agrupa itens por chave derivada (Map<chave, itens[]>). */
function groupBy<T, K>(items: readonly T[], keyFn: (item: T) => K): Map<K, T[]> {
  const map = new Map<K, T[]>();
  for (const it of items) push(map, keyFn(it), it);
  return map;
}

/** Anexa `value` ao array em `map[key]` (cria o array se ausente). */
function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const arr = map.get(key);
  if (arr) arr.push(value);
  else map.set(key, [value]);
}

/** Copy do criativo (título/corpo/CTA) — texto p/ a visão; undefined se vazio. */
function creativeCopy(c: Creative): string | undefined {
  const parts = [c.title, c.body, c.callToAction].filter(
    (p): p is string => typeof p === "string" && p.trim().length > 0,
  );
  return parts.length > 0 ? parts.join("\n") : undefined;
}

/** Enriquece a linha com o funil neutro derivado do rawActions (adapter mapper). */
function withFunnel(row: InsightRow): InsightRow {
  const funnel = funnelFromRawActions(row.rawActions);
  return funnel.length > 0 ? { ...row, funnel } : row;
}

/** KPIs + funil + scorecard + cartões por-campanha congelados p/ o site/histórico. */
function buildMetricsSnapshot(state: AccountAnalysisStateType): Record<string, unknown> | null {
  if (!state.brief) return null;
  const t = state.brief.totals;
  const cards = state.campaignCards ?? [];
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
    ...(state.brief.trackingHealth ? { trackingHealth: state.brief.trackingHealth } : {}),
    ...(state.brief.waste ? { waste: state.brief.waste } : {}),
    ...(state.analysisOutput?.scorecard ? { scorecard: state.analysisOutput.scorecard } : {}),
    // recorte por campanha congelado no run (base do histórico por-run).
    ...(cards.length > 0 ? { campaigns: cards } : {}),
    // ações que precisam de OK (5a auto-apply only) — a mini-surface lista como
    // "sugeridas". As APLICADAS ficam em agent_tool_calls (authoritative).
    ...(state.decision && state.decision.needApproval.length > 0
      ? { suggestedActions: state.decision.needApproval }
      : {}),
    // ações barradas pelo guardrail (motivo) — a mini-surface mostra como "barradas".
    ...((state.droppedActions ?? []).length > 0 ? { droppedActions: state.droppedActions } : {}),
  };
}

/**
 * Cartões por-campanha do run (todas as ativas COM análise — fresh ou herdada;
 * summarized sem análise ficam de fora, igual ao recorte do site). Congela o
 * recorte por campanha p/ o histórico, já que `entity_analyses` só guarda a última.
 */
function buildCampaignCards(
  units: readonly CampaignUnit[],
  freshById: ReadonlyMap<string, UnitAnalysis>,
  last: ReadonlyMap<string, LastEntityAnalysis>,
): RunCampaignCard[] {
  const cards: RunCampaignCard[] = [];
  for (const u of units) {
    const analysis = freshById.get(u.campaign.id) ?? last.get(u.campaign.id)?.unit;
    if (!analysis) continue;
    const m = u.campaign.metrics;
    const top = analysis.findings?.[0];
    const stage = dominantStage(u);
    cards.push({
      externalId: u.campaign.id,
      name: u.campaign.name,
      metrics: {
        spend: m.spend ?? 0,
        ...(typeof m.ctr === "number" ? { ctr: m.ctr } : {}),
        ...(typeof m.cpa === "number" ? { cpa: m.cpa } : {}),
        ...(typeof m.roas === "number" ? { roas: m.roas } : {}),
      },
      summary: analysis.summary ?? null,
      topFinding: top ? { title: top.title, severity: top.severity } : null,
      flags: [...u.campaign.flags],
      ...(u.campaign.tier ? { tier: u.campaign.tier } : {}),
      ...(stage ? { stage } : {}),
    });
  }
  return cards;
}

/**
 * Estágio de público DOMINANTE da campanha = o do adset de MAIOR gasto que tem
 * perfil de público (§Bloco 2). Adsets sem `audience` são ignorados; nenhum com
 * público → sem estágio (ausente no card). Uma campanha mistura frio/quente por
 * adset; o de maior gasto é o que melhor rotula a intenção da campanha.
 */
function dominantStage(u: CampaignUnit): AudienceStage | undefined {
  let best: { stage: AudienceStage; spend: number } | undefined;
  for (const g of u.adsets) {
    const stage = g.adset.audience?.stage;
    if (!stage) continue;
    const spend = g.adset.metrics.spend ?? 0;
    if (!best || spend > best.spend) best = { stage, spend };
  }
  return best?.stage;
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
      // `entityLevel` (não `level`, que colide com o campo reservado do pino).
      logger.warn({ entityLevel: level, err: error }, "fetch_entities:nível degradou");
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
  const params = budgetParams(rec);
  // budget sem pct válido → NÃO vira ação (evitaria daily_budget=NaN na Meta); fica consultiva.
  const budgetOk = actionType !== "adjust_budget" || ACTION_PARAM_PCT in params;
  const proposedAction: Action | null =
    actionType && rec.targetEntity && hasValidTarget && budgetOk
      ? {
          id: rec.id,
          type: actionType,
          target: { level: rec.targetEntity.level, id: rec.targetEntity.externalId },
          params,
          source: "llm",
          riskLevel: riskForAction(actionType, params),
          reason: rec.rationale,
        }
      : null;
  return {
    orgId,
    runId,
    title: rec.title,
    rationale: rec.rationale,
    proposedAction,
    riskLevel: actionType ? riskForAction(actionType, params) : "low",
  };
}

/**
 * Chave idempotente ESTÁVEL (não usa o id gerado pela LLM, que pode colidir/mudar
 * entre reprocessos). Único por (run, tipo, entidade) — e o conflito já garante ≤1
 * ação por entidade no run.
 */
function idempotencyKeyFor(runId: string, action: Action): string {
  return `${runId}:${action.type}:${entityKeyOf(action.target)}`;
}

/** Nota determinística do que o run aplicou/simulou (anexada à msg de cron). */
function appliedSummary(applied: number, attempted: number, dryRun: boolean): string | null {
  if (attempted === 0) return null;
  const failed = attempted - applied;
  const head = dryRun
    ? `🧪 Simulei ${applied} ação(ões) (dry-run) — libere a escrita pra aplicar de verdade.`
    : `✅ Apliquei ${applied} ação(ões) automaticamente.`;
  return failed > 0 ? `${head} ${failed} não deu(ram) certo agora — veja no site.` : head;
}

/**
 * Mapa `${level}:${id}` → o nível-alvo tem budget? (das entidades já buscadas).
 * Alimenta o pré-check de `adjust_budget` no guardrail (não bate na Meta à toa).
 */
function buildBudgetByEntity(entities: readonly AdEntity[]): Map<string, boolean> {
  const map = new Map<string, boolean>();
  for (const e of entities) {
    map.set(entityKeyOf({ level: e.level, id: e.id }), e.dailyBudget !== undefined || e.lifetimeBudget !== undefined);
  }
  return map;
}

/**
 * Mapa `${level}:${id}` → status atual da entidade (do catálogo cru já buscado).
 * Alimenta o no-op do guardrail (não pedir/mexer numa entidade já no estado-alvo).
 */
function buildStatusByEntity(entities: readonly AdEntity[]): Map<string, EntityStatus> {
  const map = new Map<string, EntityStatus>();
  for (const e of entities) map.set(entityKeyOf({ level: e.level, id: e.id }), e.status);
  return map;
}

/**
 * Entidades-ALVO de QUALQUER candidata de mudança de estado (pause/resume/set_status —
 * playbook ou LLM). TODAS entram na releitura pontual, não só as que o cache "bate"
 * com o alvo: o cache pode estar stale nas DUAS direções — dizendo "já terminou" quando
 * não terminou (falso no-op, barraria à toa) OU dizendo "ainda não terminou" quando já
 * terminou (no-op PERDIDO — vira sugestão desnecessária, ex: "retomar" o que já está
 * ativo). Só olhar a direção "cache bate com o alvo" cobria a 1ª e não a 2ª. Tipicamente
 * 0-3 entidades por run (não reintroduz a pressão de rate-limit que o cache evita).
 */
function statusChangeTargets(candidates: readonly Action[]): Map<string, ActionTarget> {
  const targets = new Map<string, ActionTarget>();
  for (const action of candidates) {
    if (targetStatusOf(action) === null) continue; // não é ação de status → nada a reler
    targets.set(entityKeyOf(action.target), action.target);
  }
  return targets;
}

/** Relê fresco (Meta) só as entidades-alvo e corrige o mapa cacheado. Melhor esforço:
 *  falha na leitura ou na conta → mantém o valor cacheado (não trava o run). */
async function refreshStatusByEntity(
  ioDeps: { repo: AnalysisRepo; ads: AdsPlatformPort; vault: WorkerDeps["ports"]["vault"]; logger: WorkerDeps["logger"] },
  state: AccountAnalysisStateType,
  targets: ReadonlyMap<string, ActionTarget>,
  cached: ReadonlyMap<string, EntityStatus>,
): Promise<Map<string, EntityStatus>> {
  const corrected = new Map(cached);
  const account = await ioDeps.repo.loadAccount(state.orgId, state.adAccountId);
  if (!account) return corrected;
  const accessToken = ioDeps.vault.decrypt(account.tokenCripto);
  const ref = { adAccountId: account.metaAdAccountId, accessToken };
  for (const [key, target] of targets) {
    try {
      const fresh = await ioDeps.ads.readEntityState(ref, target.id);
      corrected.set(
        key,
        mapStatus(fresh["effective_status"] as string | undefined, fresh["status"] as string | undefined),
      );
    } catch (err) {
      ioDeps.logger.warn({ runId: state.runId, entityId: target.id, err }, "guardrail:releitura de status falhou (mantém cache)");
    }
  }
  return corrected;
}

/** Params da ação de budget (direção + magnitude), quando for o caso. `pct` sempre ≥0. */
function budgetParams(rec: AnalysisRecommendation): Record<string, unknown> {
  const dir = budgetDirection(rec.actionType);
  if (dir && typeof rec.budgetChangePct === "number" && Number.isFinite(rec.budgetChangePct)) {
    return { [ACTION_PARAM_MODE]: dir, [ACTION_PARAM_PCT]: Math.abs(rec.budgetChangePct) };
  }
  return {};
}
