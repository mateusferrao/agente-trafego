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
  buildEntityConversionMap,
  buildMessageFallback,
  composeAgentPrompt,
  composeMethodologyPrompt,
  costSnapshotFromUsage,
  creativePosterFrame,
  decideActions,
  dropUnsupportedFindings,
  evaluatePlaybook,
  flagUnsupportedFindings,
  mergeUnitAnalyses,
  riskLevelForActionType,
  selectCampaignsToAnalyze,
  selectCreatives,
  type LastUnit,
} from "@trafego/core";
import { funnelFromRawActions } from "@trafego/ads-meta";
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
  AdEntity,
  CampaignUnit,
  Creative,
  CreativeVisionResult,
  EntityLevel,
  EntitySummary,
  Finding,
  InsightMetrics,
  InsightRow,
  RunCampaignCard,
} from "@trafego/shared";
import type { AdsPlatformPort, CreativeVisionPort } from "@trafego/shared/ports";
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
import { createVisionResolver, creativeContentHash } from "../../modules/vision/resolver.js";
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
import { resolveWindows } from "../../modules/analysis/window.js";
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
}

/** Fábrica de nós com deps injetadas (composition root passa `deps`). */
export function makeAccountAnalysisNodes(deps: WorkerDeps, repos?: Partial<AnalysisNodeRepos>) {
  const { logger } = deps;
  const repo = repos?.repo ?? createAnalysisRepo(deps.db);
  const snapshots = repos?.snapshots ?? createDrizzleInsightsSnapshotsRepo(deps.db);
  const notifyRepo = repos?.notify ?? createNotifyRepo(deps.db);
  const entityAnalysesRepo = repos?.entityAnalyses ?? createEntityAnalysesRepo(deps.db);

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
        const poster = creativePosterFrame(c);
        if (!poster) continue;
        const copy = creativeCopy(c);
        const result = await vision.resolve({
          creativeId: c.id,
          imageUrl: poster,
          contentHash: creativeContentHash(poster, copy),
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

  /**
   * Redator (papel dedicado) — redige a mensagem do WhatsApp a partir do resultado
   * curado. Só p/ cron (push) e quando há algo acionável; senão silêncio (decisão 4).
   * LLM barato + persona; fallback determinístico do core em erro/JSON.
   */
  async function writeMessage(state: AccountAnalysisStateType): Promise<AccountAnalysisUpdate> {
    logger.debug({ runId: state.runId }, "write_message");
    if (state.trigger !== "cron") return { outboundMessage: null }; // on-demand mostra no site
    const out = state.analysisOutput;
    if (!out || out.recommendations.length === 0 || !state.account) return { outboundMessage: null };

    const cfg = state.analysisConfig ?? deps.analysis;
    let text: string | null = null;
    let usage = state.usage;
    try {
      const completion = await deps.ports.llm.completeStructured<{ text: string }>({
        model: cfg.messageModel,
        messages: buildMessageMessages(state.systemPrompt, state.account.name, out),
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
      });
    }
    return { outboundMessage: text, usage };
  }

  /**
   * Push no WhatsApp (outbound-only, cron). Idempotente por run; só p/ contato
   * verificado + instância conectada. Degrada se a instância caiu (não quebra o run,
   * que já foi fechado no record — o site mostra o resultado de qualquer forma).
   */
  async function notify(state: AccountAnalysisStateType): Promise<AccountAnalysisUpdate> {
    logger.debug({ runId: state.runId }, "notify");
    const body = state.outboundMessage;
    if (!body) return {}; // nada acionável / não-cron → silêncio
    if (await notifyRepo.alreadyNotified(state.runId)) return {}; // idempotência de envio

    const target = await notifyRepo.loadTarget(state.orgId);
    if (!target) {
      logger.warn({ orgId: state.orgId, runId: state.runId }, "notify:sem canal/contato — sem push");
      return {};
    }

    const link = `${deps.webOrigin}/accounts/${state.adAccountId}`;
    const text = `${body}\n\nVer no site: ${link}`;
    try {
      await deps.ports.messaging.sendMessage({ instanceId: target.instanceId }, { to: target.phone, text });
      await notifyRepo.recordOutbound({
        orgId: state.orgId,
        agentId: state.agentId,
        contactId: target.contactId,
        runId: state.runId,
        body: text,
      });
    } catch (err) {
      logger.warn({ runId: state.runId, err }, "notify:envio falhou — run concluído, sem push");
    }
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
    // write-half (scaffold — 4/5a/5b): sem step por ora.
    decideActions: decideActionsNode,
    guardrailCheck,
    createApprovalAndInterrupt,
    applyActions,
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
    ...(state.analysisOutput?.scorecard ? { scorecard: state.analysisOutput.scorecard } : {}),
    // recorte por campanha congelado no run (base do histórico por-run).
    ...(cards.length > 0 ? { campaigns: cards } : {}),
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
    });
  }
  return cards;
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
