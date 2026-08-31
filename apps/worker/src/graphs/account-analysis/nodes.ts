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
  attachCreativeWeaknessSignals,
  budgetDirection,
  kindForRecommendation,
  buildAccountBrief,
  buildCuratedEntitySnapshot,
  buildEntityConversionMap,
  buildMessageFallback,
  campaignsAtBudgetCeiling,
  composeAgentVoice,
  costSnapshotFromUsage,
  creativePosterFrames,
  decideActions,
  deriveAdsetUnits,
  describeSignal,
  dropUnsupportedFindings,
  eligibilityByEntity,
  guardScaleWithoutSignificance,
  guardKillWithoutMaturity,
  guardTrackingCaveat,
  guardScaleWithWorseningMarginalCpa,
  marginalCpaRiseByEntity,
  guardAudienceScaleCeiling,
  DEFAULT_AUDIENCE_CEILING_THRESHOLDS,
  resolveFrequencyCap,
  type AudienceHeadroom,
  basisByEntity,
  annotateFreedSpend,
  detectCreationOpportunities,
  isConverterAudienceName,
  evaluatePlaybook,
  flagUnsupportedFindings,
  entityKeyOf,
  mergeUnitAnalyses,
  agentMarketReferenceFromModelConfig,
  resolveActionConflicts,
  buildTrackingRecommendation,
  resolveMarketReference,
  riskForAction,
  selectCampaignsToAnalyze,
  selectCreatives,
  targetStatusOf,
  volumeToRecCount,
  type LastUnit,
} from "@trafego/core";
import { ACTION_PARAM_MODE, ACTION_PARAM_PCT, APPROVAL_TTL_HOURS, DEFAULT_CURRENCY, DEFAULT_POSTURE, extractPhoneFromName } from "@trafego/shared";
import { recommendations } from "@trafego/db";
import { funnelFromRawActions, mapStatus } from "@trafego/ads-meta";
import { loadAccountAudiences, loadAgentContext, PROACTIVE_AUDIENCE_UNRESOLVED_REASON, PROACTIVE_REACH_FLOOR_REASON, proposeCopyCampaign, proposeCreateCampaign, proposeScaleWinner } from "../../modules/conversation/draft-proposal.js";
import { proposeTargetingForOpportunity, type ProposedTargeting } from "../../modules/conversation/propose-targeting.js";
import { autoApplyProactiveDraft, type DraftApplyOutcome } from "../../modules/apply/apply-draft.js";
import { loadEnabledTools, enabledActionTypes } from "../../modules/tools/enabled.js";
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
  EntityBreakdown,
  EntityLevel,
  EntityStatus,
  EntitySummary,
  Finding,
  InsightMetrics,
  InsightRow,
  OrgId,
  RunCampaignCard,
  RunId,
  WhatsappSource,
} from "@trafego/shared";
import type { AdsPlatformPort, CreativeVisionPort, MutationResult } from "@trafego/shared/ports";
import { AdsPlatformError, LLMProviderError } from "@trafego/shared/ports";
import type { WorkerDeps } from "../../composition.js";
import {
  createDrizzleInsightsSnapshotsRepo,
  type InsightsSnapshotsRepo,
} from "../../modules/insights/repo.js";
import {
  createDrizzleInsightsBreakdownsRepo,
  type InsightsBreakdownsRepo,
} from "../../modules/insights/breakdown-repo.js";
import {
  createAnalysisRepo,
  type AdCreativeRow,
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
import { createSendToConversation } from "../../modules/notify/send-to-contact.js";
import { createVisionResolver, servingVisionKey } from "../../modules/vision/resolver.js";
import { makeMetaToolExecutor, type MetaToolExecutor } from "../../executors/meta-tools.js";
import { AnalysisError } from "../../modules/analysis/errors.js";
import { mapWithConcurrency } from "../../lib/concurrency.js";
import { resolveAnalysisConfig, type ResolvedAnalysisConfig } from "../../modules/analysis/config.js";
import {
  buildCampaignMessages,
  buildReviewMessages,
  buildSynthesisMessages,
  type AdCopy,
} from "../../modules/analysis/prompt.js";
import {
  buildMessageMessages,
  MESSAGE_OUTPUT_JSON_SCHEMA,
  MESSAGE_OUTPUT_SCHEMA_NAME,
} from "../../modules/notify/prompt.js";
import { resolveWindows, todayInTz } from "@trafego/core";
import type { AccountAnalysisStateType, AccountAnalysisUpdate } from "./state.js";

/** Nº de dias sem análise que dispara um run DEEP (reanalisa tudo). */
const DAY_MS = 24 * 60 * 60 * 1000;

/** Piso de alcance mensal (Fatia 8) pra o AUTÔNOMO criar/replicar sozinho — abaixo disso a proposta
 *  degrada pra recomendação humana em vez de criar. Fast-follow: tornar configurável por-agente. */
const PROACTIVE_MIN_MONTHLY_REACH = 5000;

/** Título da recomendação PROATIVA por tipo de oportunidade de criação (Fatia 8). */
function creationRecTitle(kind: string): string {
  switch (kind) {
    case "remarketing":
      return "Criar um remarketing";
    case "replicate_winner":
      return "Replicar seu vencedor pra um público novo";
    case "prospecting_expansion":
      return "Abrir uma nova prospecção";
    case "cold_start":
      return "Criar uma campanha inicial";
    default:
      return "Criar uma campanha nova";
  }
}

/** Mapeia o público proposto pela LLM (por NOME) → args de create/copy (resolvidos determinístico
 *  depois, autônomo-safe). Só inclui o que a LLM realmente propôs (campos vazios ficam de fora). */
function proposalToCreationArgs(p: ProposedTargeting): {
  geo?: readonly string[];
  radiusKm?: number;
  ageMin?: number;
  ageMax?: number;
  gender?: "all" | "men" | "women";
  interests?: readonly string[];
  behaviors?: readonly string[];
  includeAudiences?: readonly string[];
  excludeAudiences?: readonly string[];
} {
  return {
    ...(p.geoNames.length > 0 ? { geo: p.geoNames } : {}),
    ...(p.radiusKm != null ? { radiusKm: p.radiusKm } : {}),
    ...(p.ageMin != null ? { ageMin: p.ageMin } : {}),
    ...(p.ageMax != null ? { ageMax: p.ageMax } : {}),
    ...(p.gender ? { gender: p.gender } : {}),
    ...(p.interestNames.length > 0 ? { interests: p.interestNames } : {}),
    ...(p.behaviorNames.length > 0 ? { behaviors: p.behaviorNames } : {}),
    ...(p.includeAudienceNames.length > 0 ? { includeAudiences: p.includeAudienceNames } : {}),
    ...(p.excludeAudienceNames.length > 0 ? { excludeAudiences: p.excludeAudienceNames } : {}),
  };
}

const SEGMENT_LEVELS: readonly EntityLevel[] = ["campaign", "adset", "ad"];
const ANALYSIS_TEMPERATURE = 0.2;
const NO_ACTIVITY_SUMMARY =
  "Sua conta não teve gasto nem impressões no período. Não há o que analisar por enquanto.";

/** Empty-state amigável do chat/on-demand em conta zerada (+ oferta de alerta se OFF). */
function buildNoActivityMessage(accountName: string, offerReactivation: boolean): string {
  const base = `${accountName}: não teve gasto nem impressões nos últimos dias — não há dados pra analisar ainda.`;
  return offerReactivation ? `${base}\n\nQuer que eu te avise assim que ela voltar a rodar?` : base;
}


/** Repos usados pelos nós — injetáveis p/ teste (default = Drizzle sobre deps.db). */
export interface AnalysisNodeRepos {
  readonly repo: AnalysisRepo;
  readonly snapshots: InsightsSnapshotsRepo;
  /** Breakdown demográfico/posicionamento (S7) — cadência própria. */
  readonly breakdowns: InsightsBreakdownsRepo;
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
  const breakdowns = repos?.breakdowns ?? createDrizzleInsightsBreakdownsRepo(deps.db);
  const notifyRepo = repos?.notify ?? createNotifyRepo(deps.db);
  const entityAnalysesRepo = repos?.entityAnalyses ?? createEntityAnalysesRepo(deps.db);
  const executor = repos?.executor ?? makeMetaToolExecutor(deps);
  const sendToConversation = createSendToConversation({ messaging: deps.ports.messaging, repo: notifyRepo });

  /** Carrega agent/config/janela e abre o run (status=running, snapshot congelado). */
  async function loadContext(state: AccountAnalysisStateType): Promise<AccountAnalysisUpdate> {
    logger.debug({ runId: state.runId }, "load_context");
    const ctx = await repo.loadAgentContext(state.orgId, state.agentId);
    if (!ctx) throw new AnalysisError("agent_missing", "agente não encontrado");

    // Bindings AUTORITATIVOS também no caminho AUTÔNOMO (3ª superfície de escrita): resolve
    // allowedActions dos bindings (mesma fonte do chat/apply) e CONGELA no snapshot do run
    // (reprodutibilidade — travado no início, refletindo a capacidade atual). Sem isto, desligar
    // uma ação nos bindings não impediria o agente de aplicá-la sozinho (o guardrail leria a
    // coluna allowedActions, hoje vestigial). Fallback preserva o comportamento.
    const enabledTools = await loadEnabledTools(deps.db, state.orgId, state.agentId, ctx.guardrailConfig.allowedActions);
    const guardrailConfig = { ...ctx.guardrailConfig, allowedActions: enabledActionTypes(enabledTools) };

    // config resolvida por-agente (model_config) com fallback nos defaults globais.
    const cfg = resolveAnalysisConfig(ctx.modelConfig, deps.analysis);
    // systemPrompt LIMPO (voz base) = metodologia/override + identidade + personalização
    // (fonte única `composeAgentVoice`). A POSTURA é bloco à parte, anexado só nos prompts
    // que FALAM (redator). A nota do sinal (F4) idem — só no ANALISTA (via analystPrompt),
    // NUNCA no redator (que redige ao usuário, sem diretiva de investigação em 2ª pessoa).
    const systemPrompt = composeAgentVoice(ctx);
    // "hoje" no fuso da org (não UTC) — casa o dia civil dos snapshots (fuso da conta Meta).
    const { window, baseline } = resolveWindows(todayInTz(new Date(), ctx.timezone), cfg.windowDays, cfg.baselineDays);
    const windowLabel = `últimos ${cfg.windowDays} dias`;
    const baselineLabel = `${cfg.baselineDays} dias anteriores`;

    await repo.openRun(state.orgId, state.runId, {
      goals: ctx.goals,
      model: cfg.model,
      reviewEnabled: cfg.reviewEnabled,
      window,
      baseline,
      topN: cfg.topN,
      // congela a postura usada no render (reprodutibilidade — CLAUDE §6).
      posture: ctx.posture,
    });

    return {
      goals: ctx.goals,
      playbookRules: ctx.playbook,
      autonomyPolicy: ctx.autonomyPolicy,
      notifyPolicy: ctx.notifyPolicy,
      posture: ctx.posture,
      guardrailConfig,
      rejectedMemory: ctx.rejectedMemory,
      mutedCampaignIds: ctx.mutedCampaignIds,
      orgMarketReference: ctx.orgMarketReference,
      agentMarketReference: agentMarketReferenceFromModelConfig(ctx.modelConfig),
      systemPrompt,
      vertical: ctx.vertical,
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
    // Breakdown demográfico/posicionamento (S7) — cadência PRÓPRIA (auto-throttle interno),
    // best-effort: nunca aborta o run (mesma filosofia de `listCustomAudiences` abaixo).
    try {
      const activeCampaignIds = entities.filter((e) => e.level === "campaign" && e.status === "active").map((e) => e.id);
      await deps.breakdownSync.sync({
        orgId: state.orgId,
        adAccountUuid: state.adAccountId,
        metaAdAccountId: account.metaAdAccountId,
        accessToken,
        campaignIds: activeCampaignIds,
        goals: state.goals,
        now: Date.now(),
      });
    } catch (err) {
      logger.warn({ runId: state.runId, err: String(err) }, "fetch_data:breakdown_sync degradou");
    }
    // Lê o breakdown de CONTA já sincronizado (gate de materialidade roda em
    // `buildAccountBrief`, não aqui — este passo só carrega o cru).
    let demographics: EntityBreakdown | null = null;
    let placements: EntityBreakdown | null = null;
    try {
      const stored = await breakdowns.listByAccount(state.adAccountId);
      const accountRows = stored.filter((r) => r.entityLevel === "account");
      const demo = accountRows.find((r) => r.dimension === "demographic");
      const place = accountRows.find((r) => r.dimension === "placement");
      demographics = demo ? { dimension: "demographic", segments: demo.segments, asOf: demo.date } : null;
      placements = place ? { dimension: "placement", segments: place.segments, asOf: place.date } : null;
    } catch (err) {
      logger.warn({ runId: state.runId, err: String(err) }, "fetch_data:load_breakdowns degradou");
    }
    // persiste os rótulos de conversão resolvidos (id→nome) p/ a config ler do banco
    // sem falar com a plataforma (Fatia 4). Genérico: platform como coluna.
    await repo.saveConversionLabels(state.orgId, state.adAccountId, ADS_PLATFORM, collectConversionLabels(entities));
    // Cache dos custom audiences da conta (Fatia 7): a análise completa busca 1x + persiste;
    // o chat lê DB-first (Meta só no fallback, evita rate limit). Best-effort — nunca aborta o run.
    try {
      const audiences = await deps.ports.ads.listCustomAudiences(ref);
      await repo.saveCustomAudiences(state.orgId, state.adAccountId, audiences);
    } catch (err) {
      logger.warn({ runId: state.runId, err: String(err) }, "fetch_data:cache_audiences degradou");
    }
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
      demographics,
      placements,
      partial: sync.partial || entitiesPartial || creativesPartial,
      partialReasons: [
        ...(sync.partial ? ["metrics" as const] : []),
        ...(entitiesPartial ? ["entities" as const] : []),
        ...(creativesPartial ? ["creative_vision" as const] : []),
      ],
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
    // referência de mercado (pivô): org-default + override por agente, resolvidos na
    // moeda da conta (match-or-drop). `operational.zombieMinSpend` (currency-aware) tem
    // precedência sobre o piso legado de `cfg.quality.zombieMinSpend`.
    const market = resolveMarketReference(
      state.orgMarketReference ?? null,
      state.agentMarketReference ?? null,
      state.account.currency ?? null,
    );
    const quality =
      market.zombieMinSpend !== undefined
        ? { ...cfg.quality, zombieMinSpend: market.zombieMinSpend }
        : cfg.quality;
    const built = buildAccountBrief({
      account: { id: state.account.metaAdAccountId, name: state.account.name, currency: state.account.currency },
      window: state.window.label,
      windowDays: cfg.windowDays,
      baselineWindow: state.baseline.label,
      goals: state.goals,
      entities: state.entities,
      rows: state.insights,
      baselineRows: state.baselineInsights,
      playbookCandidates: state.playbookCandidates,
      topN: cfg.topN,
      notableAdsPerCampaign: cfg.notableAdsPerCampaign,
      qualityThresholds: quality,
      ...(market.costTable ? { costTable: market.costTable } : {}),
      ...(market.ctrBands ? { ctrBands: market.ctrBands } : {}),
      ...(market.frequencyAlert !== undefined ? { frequencyAlert: market.frequencyAlert } : {}),
      ...(state.mutedCampaignIds ? { mutedCampaignIds: new Set(state.mutedCampaignIds) } : {}),
      ...(state.demographics ? { demographics: state.demographics } : {}),
      ...(state.placements ? { placements: state.placements } : {}),
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

    // S1 — persistir copy + desempenho denormalizado (1 linha viva por anúncio).
    // Best-effort: nunca aborta o run. Alimenta "qual copy campeã" e o bloco
    // `copyByAdId` da análise, sem re-baixar da Meta. Perf vem do brief (tier/métricas).
    try {
      const adPerfById = new Map(built.brief.segments.ads.map((e) => [e.id, e]));
      // hierarquia anúncio→campanha/adset + nome da campanha, dos ENTITIES já listados
      // (Fatia 7). Resolve o destino WhatsApp SEM chamada extra à Meta: CTA do criativo
      // (`meta_cta`) ou, na ausência, o nome da campanha (`campaign_name`, pede confirmação
      // no chat). O tier `meta_page` (1 GET/Página) fica p/ o fallback ao vivo — não onera
      // o run. Cache DB-first; live é fallback.
      const adEntityById = new Map((state.entities ?? []).filter((e) => e.level === "ad").map((e) => [e.id, e]));
      const adsetById = new Map((state.entities ?? []).filter((e) => e.level === "adset").map((e) => [e.id, e]));
      const campaignNameById = new Map(
        (state.entities ?? []).filter((e) => e.level === "campaign").map((e) => [e.id, e.name]),
      );
      const creativeRows: AdCreativeRow[] = (state.creatives ?? []).map((c) => {
        const perf = adPerfById.get(c.adId);
        const entity = adEntityById.get(c.adId);
        const campaignId = entity?.campaignId ?? null;
        // destino CTWA do CONJUNTO (promoted_object) — a fonte autoritativa em click-to-WhatsApp,
        // onde o CTA vem sem número. Cacheia aqui p/ o chat ler DB-first (sem GET ao vivo).
        const fromPromoted = entity?.adsetId ? (adsetById.get(entity.adsetId)?.whatsappNumber ?? null) : null;
        const campaignName = campaignId ? campaignNameById.get(campaignId) : undefined;
        const fromName = campaignName ? extractPhoneFromName(campaignName) : null;
        const whatsappNumber = fromPromoted ?? c.whatsappNumber ?? fromName ?? null;
        const whatsappSource: WhatsappSource | null = fromPromoted
          ? "meta_promoted_object"
          : c.whatsappNumber
            ? "meta_cta"
            : fromName
              ? "campaign_name"
              : null;
        return {
          adId: c.adId,
          creativeId: c.id ?? null,
          body: c.body ?? null,
          title: c.title ?? null,
          callToAction: c.callToAction ?? null,
          imageUrl: c.imageUrl ?? null,
          imageHash: c.imageHash ?? null,
          thumbnailUrl: c.thumbnailUrl ?? null,
          videoId: c.videoId ?? null,
          whatsappNumber,
          whatsappSource,
          campaignId,
          adsetId: entity?.adsetId ?? null,
          tier: perf?.tier ?? null,
          spend: perf?.metrics.spend ?? null,
          cpa: perf?.metrics.cpa ?? null,
          roas: perf?.metrics.roas ?? null,
        };
      });
      await repo.saveAdCreatives(state.orgId, state.adAccountId, state.runId, creativeRows);
    } catch (err) {
      logger.warn({ runId: state.runId, err: String(err) }, "map_units:persist_copy degradou");
    }
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
    // S8: medição suspeita é sinal de CONTA (built.brief.trackingHealth) — repassada a
    // CADA campanha do mapa, não só na síntese (o caveat vale por-campanha).
    const trackingSuspect = built.brief.trackingHealth?.suspect === true;
    const outcomes = await mapWithConcurrency(selection.toAnalyze, cfg.mapConcurrency, async (unit) => {
      // visão dos criativos dos anúncios notáveis DESTA campanha (teto por campanha).
      const notableAdIds = unit.adsets.flatMap((g) => g.notableAds.map((a) => a.id));
      const chosenCreatives = selectCreatives(notableAdIds, creativesByAdId, cfg.maxCreativesVisionPerCampaign);
      const visionByAdId = new Map<string, CreativeVisionResult[]>();
      for (const c of chosenCreatives) {
        const frames = creativePosterFrames(c);
        if (frames.length === 0) continue;
        const copy = creativeCopy(c);
        // chave de cache ESTÁVEL (fonte única `servingVisionKey`) — reusada pela criação de
        // campanha p/ o cache-hit ser consistente (id do criativo + vídeo + copy).
        const result = await vision.resolve({
          creativeId: c.id,
          imageUrls: frames,
          contentHash: servingVisionKey(c.id, c.videoId, copy),
          ...(copy ? { copy } : {}),
        });
        if (result) push(visionByAdId, c.adId, result);
      }
      // S4b: anexa weak_creative aos anúncios notáveis cuja visão indica prova fraca +
      // baixa persuasão — o analista lê o sinal nomeado (QUALITY_TEXT), não precisa
      // re-inferir de proofStrength/persuasionSignals crus a cada vez.
      const enrichedUnit = attachCreativeWeaknessSignals(unit, visionByAdId);

      // copy VERBATIM dos anúncios notáveis (texto real, complementa a visão).
      const copyByAdId = new Map<string, AdCopy>();
      for (const adId of notableAdIds) {
        const c = creativesByAdId.get(adId)?.[0];
        if (!c) continue;
        const entry: AdCopy = {
          ...(c.body ? { body: c.body } : {}),
          ...(c.title ? { title: c.title } : {}),
          ...(c.callToAction ? { callToAction: c.callToAction } : {}),
        };
        if (entry.body || entry.title || entry.callToAction) copyByAdId.set(adId, entry);
      }

      try {
        const completion = await deps.ports.llm.completeStructured<UnitAnalysis>({
          model: cfg.unitModel,
          messages: buildCampaignMessages(analystPrompt(state), enrichedUnit, visionByAdId, {
            currency: accountCurrency,
            window: windowLabel,
            ...(businessGoal ? { businessGoal } : {}),
            trackingSuspect,
          }, copyByAdId, state.vertical),
          responseSchema: UNIT_ANALYSIS_JSON_SCHEMA,
          responseSchemaName: UNIT_ANALYSIS_SCHEMA_NAME,
          temperature: ANALYSIS_TEMPERATURE,
          maxTokens: cfg.maxOutputTokens,
          ...(cfg.unitFallbackModels.length > 0 ? { fallbackModels: cfg.unitFallbackModels } : {}),
          // Mapa = extração JSON estrita: reasoning OFF (o modelo unit é instruct; reasoning
          // só gastaria orçamento/latência e arrisca truncar o JSON). Síntese/revisão mantêm.
          reasoning: { effort: "off" },
          // valida contra o zod DENTRO do adapter → output inválido re-chama o LLM (retry)
          // em vez de cair fora e descartar a análise (o custo já foi pago).
          validate: (o) => unitAnalysisSchema.safeParse(o).success,
          meta: { orgId: state.orgId, runId: state.runId, type: "unit" },
        });
        // Rede de segurança: com `validate` acima, o adapter já garante validade; se ainda
        // assim falhar, LOGA (antes era drop silencioso — análise sumia sem rastro).
        const parsed = unitAnalysisSchema.safeParse(completion.output);
        if (!parsed.success) {
          logger.warn(
            { runId: state.runId, campaign: unit.campaign.id, issues: parsed.error.issues.slice(0, 5) },
            "map_units:output do modelo unit não passou no schema — campanha descartada",
          );
          return { unit: null, fresh: [], usage: completion.usage, partial: true };
        }
        const campaignFresh: FreshUnit = {
          entityId: unit.campaign.id,
          entityLevel: "campaign",
          entityName: unit.campaign.name,
          unit: parsed.data,
          metrics: unit.campaign.metrics,
          flags: [...unit.campaign.flags],
          ...(unit.campaign.tier ? { tier: unit.campaign.tier } : {}),
          curated: buildCuratedEntitySnapshot(unit.campaign),
        };
        // S8b: campanha ABO com 2+ adsets ativos ganha diagnóstico próprio POR ADSET —
        // DERIVADO da mesma call já feita (zero LLM extra, ver deriveAdsetUnits).
        const adsetFresh: FreshUnit[] = deriveAdsetUnits(enrichedUnit, parsed.data).map(({ adset, unit: adsetUnit }) => ({
          entityId: adset.id,
          entityLevel: "adset",
          entityName: adset.name,
          unit: adsetUnit,
          metrics: adset.metrics,
          flags: [...adset.flags],
          ...(adset.tier ? { tier: adset.tier } : {}),
          curated: buildCuratedEntitySnapshot(adset),
        }));
        return { unit: parsed.data, fresh: [campaignFresh, ...adsetFresh], usage: completion.usage, partial: false };
      } catch (err) {
        if (!(err instanceof LLMProviderError)) throw err;
        logger.warn({ runId: state.runId, campaign: unit.campaign.id, err }, "map_units:campanha falhou");
        return { unit: null, fresh: [], usage: null, partial: true };
      }
    });

    // REDUÇÃO (sequencial, sem race): soma usage, agrega parcial, coleta unidades.
    const unitAnalyses: UnitAnalysis[] = [];
    const freshUnits: FreshUnit[] = [];
    let usage = state.usage;
    let partial = state.partial ?? false;
    let campaignPartial = false;
    for (const o of outcomes) {
      if (o.usage) usage = addTokenUsage(usage ?? undefined, o.usage);
      if (o.partial) { partial = true; campaignPartial = true; }
      if (o.unit) unitAnalyses.push(o.unit);
      freshUnits.push(...o.fresh);
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

    return {
      brief: built.brief, unitAnalyses, freshUnits, campaignCards, usage, partial,
      ...(campaignPartial ? { partialReasons: ["campaign_analysis" as const] } : {}),
    };
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
        messages: buildSynthesisMessages(analystPrompt(state), state.brief, units, state.vertical),
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
    let reviewDegraded = false;

    if (cfg.reviewEnabled) {
      const issues = flagUnsupportedFindings(draft, state.brief);
      try {
        const completion = await deps.ports.llm.completeStructured<AnalysisOutput>({
          model: cfg.reviewModel,
          messages: buildReviewMessages(state.brief, draft, issues, state.vertical),
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
          partial = true; reviewDegraded = true; // revisor devolveu fora do schema → usa o analista
          logger.warn({ runId: state.runId }, "review:output fora do schema; usando analista");
        }
      } catch (err) {
        if (!(err instanceof LLMProviderError)) throw err; // erro inesperado sobe
        partial = true; reviewDegraded = true; // revisor falhou → degradação graciosa (usa o analista)
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
    // guard de tracking (Bloco 2 → pivô saúde): rebaixa pausar/cortar → investigar
    // quando a medição da conta parece incompleta (antes só anexava caveat; ver
    // ROADMAP `[ALTO]` "guard de tracking mais forte no caminho autônomo").
    const caveated = guardTrackingCaveat(guarded, basisByEntity(state.brief), state.brief.trackingHealth);
    // CPA marginal (pivô saúde, squad traffic-masters): rebaixa escalar → investigar quando
    // o CPA piorou vs baseline acima do limiar, mesmo pra quem ainda bate a meta em média
    // ("CPA médio mente, o marginal conta a verdade") — guard de significância não pega esse caso.
    const marginalGuarded = guardScaleWithWorseningMarginalCpa(
      caveated,
      marginalCpaRiseByEntity(state.brief),
      { worsenPct: cfg.quality.marginalCpaWorsenPct },
    );
    // Teto de escala por audiência (Fase 4): reativo (só as entidades que sobreviveram
    // com proposta de escalar até aqui) — rebaixa escalar → investigar quando o público
    // (MAU × teto de frequência saudável) já está perto do limite de impressões sustentáveis.
    const audienceHeadroom = await resolveAudienceHeadroomByEntity(
      { repo, ads: deps.ports.ads, vault: deps.ports.vault, logger },
      state,
      marginalGuarded,
      cfg,
    );
    const audienceGuarded = guardAudienceScaleCeiling(marginalGuarded, audienceHeadroom, DEFAULT_AUDIENCE_CEILING_THRESHOLDS);
    // impacto (Bloco 2): anexa o gasto liberado a cada recomendação de pausa.
    const spendById = new Map<string, number>();
    for (const level of [state.brief.segments.campaigns, state.brief.segments.adsets, state.brief.segments.ads]) {
      for (const e of level) spendById.set(e.id, e.metrics.spend ?? 0);
    }
    const final = annotateFreedSpend(audienceGuarded, spendById, state.brief.account.currency);
    const findings: Finding[] = final.findings.map((f) => ({
      title: f.title,
      detail: f.detail,
      severity: f.severity,
    }));
    return {
      analysisOutput: final, findings, summary: final.summary, usage, partial,
      ...(reviewDegraded ? { partialReasons: ["review" as const] } : {}),
    };
  }

  /** Persiste recommendations (feedback/outcome tracking + base p/ 5a). */
  async function buildRecommendations(
    state: AccountAnalysisStateType,
  ): Promise<AccountAnalysisUpdate> {
    logger.debug({ runId: state.runId }, "build_recommendations");
    // Medição furada (Bloco 2/D): recomendação human_direction de TOPO — emitida ANTES das do LLM
    // (createdAt mais cedo) e independente da análise do LLM ter degradado. Alto valor, risco zero
    // (não executável; o fix é no pixel/Meta). O sinal já foi computado determinísticamente no brief.
    const trackingRec = buildTrackingRecommendation(state.brief?.trackingHealth);
    if (trackingRec) {
      await deps.db.insert(recommendations).values({
        orgId: state.orgId,
        runId: state.runId,
        title: trackingRec.title,
        rationale: trackingRec.rationale,
        kind: "human_direction",
        riskLevel: "low",
      });
      logger.info({ runId: state.runId }, "build_recommendations:tracking suspeito → recomendação");
    }
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

  /**
   * PROATIVO de criação (Fatia 7): detecta oportunidade (determinístico) + propõe rascunho
   * (scale/create) → campaign_drafts(proposed) + approval + recommendation (draftId, reusa
   * outcome tracking). Gated por notifyPolicy.proactiveDrafts; throttle = partial-unique
   * (1 proposto proativo/conta) → conflito é engolido. NUNCA auto-aplica (sempre aprovação).
   */
  /**
   * Nudge TRANSPARENTE da auto-criação (C): o quê + porquê + que nasceu PAUSADA + próximo passo.
   * Honestidade obrigatória — o agente agiu sozinho, o dono precisa saber e poder ativar/desfazer.
   * Best-effort (Evolution fora não quebra o run). Alvo org-level (grupo ativo, senão DM).
   */
  async function pushCreationNudge(
    state: AccountAnalysisStateType,
    toolKey: "duplicate_scale" | "create_campaign",
    rationale: string,
    outcome: DraftApplyOutcome,
  ): Promise<void> {
    const isScale = toolKey === "duplicate_scale";
    const what = isScale ? "dupliquei seu vencedor pra escalar" : "criei uma campanha nova";
    const wouldHave = isScale ? "duplicar seu vencedor" : "criar uma campanha";
    let text: string;
    if (outcome.kind === "created") {
      // v1: creationActivation decide se nasceu ativa (no ar) ou pausada (revisar+ativar). Aviso
      // honesto do que o agente fez sozinho, nos dois casos.
      text = outcome.dryRun
        ? `🧪 Simulei uma criação automática (dry-run): ${what}. Por quê: ${rationale}.`
        : outcome.activated
          ? `🤖 Agi sozinho e ${what} — e já ATIVEI (está no ar). Por quê: ${rationale}. Se precisar, dá pra pausar na plataforma.`
          : `🤖 Agi sozinho e ${what} — deixei **pausada**, esperando seu OK (não veicula até você ativar). Por quê: ${rationale}. Dá uma olhada na plataforma e ative quando quiser.`;
    } else if (outcome.kind === "blocked" || outcome.kind === "unsupported") {
      text = `Ia ${wouldHave} sozinho, mas parei: ${outcome.reason}.`;
    } else {
      text = `Tentei ${wouldHave} sozinho, mas não consegui agora — deixei pendente pra você revisar.`;
    }
    const ref = await notifyRepo.loadTarget(state.orgId);
    if (!ref) return;
    try {
      await sendToConversation(ref, text, { split: false });
    } catch (err) {
      logger.warn({ runId: state.runId, err: String(err) }, "propose_drafts:nudge de auto-criação falhou");
    }
  }

  async function proposeDrafts(state: AccountAnalysisStateType): Promise<AccountAnalysisUpdate> {
    const enabled = state.notifyPolicy?.proactiveDrafts?.enabled === true;
    if (!enabled || !state.brief) return {};
    const campaigns = state.brief.segments?.campaigns ?? [];
    const entities = campaigns.map((c) => ({
      id: c.id,
      level: c.level,
      name: c.name,
      ...(c.tier ? { tier: c.tier } : {}),
      significant: c.eligibility?.hasSignificance ?? false,
      // P1.2: sinal REAL (CBO/ABO/vitalício, attachBudgetCeiling no brief) — `undefined` só
      // quando genuinamente indeterminável (sem budget em lugar nenhum); nesse caso um vencedor
      // provado ainda é proposto pro humano revisar (§8), mas o AUTO-apply exige `true` confirmado.
      ...(c.atBudgetCeiling !== undefined ? { atBudgetCeiling: c.atBudgetCeiling } : {}),
      // fadiga de CRIATIVO × saturação de PÚBLICO são sinais distintos (Fatia 8): a 1ª vira
      // refresh_fatigued (só recomendação), a 2ª vira prospecting_expansion (público novo, acionável).
      fatigued: (c.healthSignals ?? []).some((h) => h === "creative_fatigue"),
      saturated: (c.healthSignals ?? []).some((h) => h === "audience_saturation"),
      spending: (c.metrics?.spend ?? 0) > 0,
    }));
    const hasActive = campaigns.some((c) => c.status === "active");

    const dctx = {
      orgId: state.orgId,
      agentId: state.agentId,
      adAccountId: state.adAccountId,
      currency: state.brief.account?.currency ?? DEFAULT_CURRENCY,
    };
    // públicos salvos da conta (cache do run, DB-first) → habilita remarketing + alimenta a LLM.
    // Best-effort: qualquer falha degrada (sem contexto/públicos) — nunca quebra o proativo.
    let ac: Awaited<ReturnType<typeof loadAgentContext>> = null;
    let savedAudienceNames: string[] = [];
    let hasConverterAudience = false;
    try {
      ac = await loadAgentContext(deps, dctx);
      if (ac) {
        const saved = await loadAccountAudiences(deps, dctx, ac.ref);
        savedAudienceNames = saved.map((a) => a.name);
        hasConverterAudience = saved.some((a) => !a.isLookalike && isConverterAudienceName(a.name));
      }
    } catch (err) {
      logger.debug({ runId: state.runId, err: String(err) }, "propose_drafts:contexto/audiences degradou");
    }

    const top = detectCreationOpportunities({ hasActiveCampaigns: hasActive, hasConverterAudience, entities })[0];
    if (!top) return {};

    // P1.1: `refresh_fatigued` vira SÓ recomendação (human_direction) — sem rascunho/approval/
    // auto-apply. `proposeCreateCampaign` reusaria o MESMO criativo já fatigado (não temos
    // geração de criativo por IA ainda), o que contradiria o rationale "teste um ângulo novo".
    // O agente não promete o que não entrega — nunca chega no ramo `byAction[...] === "act_full"`.
    if (top.kind === "refresh_fatigued") {
      await deps.db.insert(recommendations).values({
        orgId: state.orgId,
        runId: state.runId,
        title: "Testar um ângulo novo",
        rationale: top.rationale,
        kind: "human_direction",
        riskLevel: "low",
      });
      logger.info({ runId: state.runId, kind: top.kind }, "propose_drafts:recomendação (sem draft)");
      return {};
    }

    try {
      // ── SCALE: escala o vencedor as-is (não usa LLM de público) ──────────────────────────────
      if (top.kind === "scale_winner") {
        const proposal = await proposeScaleWinner(deps, dctx, top.entityName, "proactive");
        // vencedor no teto sob CBO/ABO-pequeno → a decisão é SUBIR BUDGET (adjust_budget), não duplicar.
        if (proposal.kind === "action") {
          await deps.ports.approval.upsertPending({
            orgId: state.orgId as OrgId,
            agentId: state.agentId as AgentId,
            runId: state.runId as RunId,
            action: proposal.action,
            expiresAt: new Date(Date.now() + APPROVAL_TTL_HOURS * 3_600_000),
          });
          await deps.db.insert(recommendations).values({
            orgId: state.orgId,
            runId: state.runId,
            title: "Escalar seu vencedor (subir orçamento)",
            rationale: top.rationale,
            kind: "platform_action",
            toolKey: "adjust_budget",
            riskLevel: "medium",
          });
          logger.info({ runId: state.runId }, "propose_drafts:scale_raise proposto");
          return {};
        }
        if (proposal.kind !== "draft") return {};
        await deps.db.insert(recommendations).values({
          orgId: state.orgId,
          runId: state.runId,
          title: "Escalar seu vencedor",
          rationale: top.rationale,
          kind: "platform_action",
          toolKey: "duplicate_scale",
          draftId: proposal.draftId,
          riskLevel: "high",
        });
        logger.info({ runId: state.runId, kind: top.kind }, "propose_drafts:proposto");
        if (state.autonomyPolicy?.byAction?.["duplicate_scale"] === "act_full") {
          const outcome = await autoApplyProactiveDraft(deps, { orgId: state.orgId, draftId: proposal.draftId, approvalId: proposal.approvalId });
          await pushCreationNudge(state, "duplicate_scale", top.rationale, outcome);
          logger.info({ runId: state.runId, kind: top.kind, outcome: outcome.kind }, "propose_drafts:auto");
        }
        return {};
      }

      // ── CRIAÇÃO SEGMENTADA (Fatia 8): a LLM propõe o PÚBLICO por NOME (o QUÊ é determinístico, o
      // COMO é a LLM); a resolução na casca descarta o inexistente (autônomo-safe) e o piso de
      // alcance evita criar estreito sozinho (degrada pra recomendação humana). ────────────────
      const proposedTargeting = ac
        ? await proposeTargetingForOpportunity(deps.ports.llm, {
            kind: top.kind,
            rationale: top.rationale,
            model: ac.model,
            businessContext: ac.businessContext,
            guidance: ac.guidance,
            ...(state.goals?.conversionGoal ? { conversionGoal: state.goals.conversionGoal } : {}),
            savedAudienceNames,
            ...(top.entityId ? { winnerCampaignId: top.entityId } : {}),
            meta: { orgId: state.orgId, runId: state.runId },
          })
        : null;
      const args = proposedTargeting ? proposalToCreationArgs(proposedTargeting) : {};
      // remarketing EXIGE público de convertidos/engajados resolvido — sem ele, não cria amplo às
      // cegas (perderia a intenção): degrada pra recomendação humana (requireResolvedAudience).
      const autoOpts = { autonomous: true, minMonthlyReach: PROACTIVE_MIN_MONTHLY_REACH, requireResolvedAudience: top.kind === "remarketing" };
      // replicate_winner COPIA a estrutura do vencedor (sourceCampaignId determinístico) + público
      // proposto; as demais (remarketing/prospecting/cold_start) criam do zero com o público proposto.
      const proposal =
        top.kind === "replicate_winner" && top.entityId
          ? await proposeCopyCampaign(deps, dctx, { sourceCampaignId: top.entityId, ...(top.entityName ? { sourceName: top.entityName } : {}), ...args }, "proactive", autoOpts)
          : await proposeCreateCampaign(deps, dctx, args, "proactive", autoOpts);

      // Degradação honesta pra recomendação humana (não cria sozinho): público estreito (piso de
      // alcance) OU público específico não-resolvido (ex: remarketing sem público de convertidos).
      if (proposal.kind === "blocked" && (proposal.reason === PROACTIVE_REACH_FLOOR_REASON || proposal.reason === PROACTIVE_AUDIENCE_UNRESOLVED_REASON)) {
        const why =
          proposal.reason === PROACTIVE_REACH_FLOOR_REASON
            ? "Mas o público ficou estreito demais pra eu criar sozinho — dá uma olhada e ajuste."
            : "Mas não achei o público específico pra montar sozinho — dá uma olhada e me diga qual usar.";
        await deps.db.insert(recommendations).values({
          orgId: state.orgId,
          runId: state.runId,
          title: creationRecTitle(top.kind),
          rationale: `${top.rationale} ${why}`,
          kind: "human_direction",
          riskLevel: "low",
        });
        logger.info({ runId: state.runId, kind: top.kind, reason: proposal.reason }, "propose_drafts:degrada → recomendação");
        return {};
      }
      if (proposal.kind !== "draft") return {};

      const toolKey = "create_campaign";
      await deps.db.insert(recommendations).values({
        orgId: state.orgId,
        runId: state.runId,
        title: creationRecTitle(top.kind),
        rationale: top.rationale,
        kind: "platform_action",
        toolKey,
        draftId: proposal.draftId,
        riskLevel: "high",
      });
      logger.info({ runId: state.runId, kind: top.kind }, "propose_drafts:proposto");

      // auto-criação PROATIVA (byAction[create_campaign] === act_full): cria JÁ + guardrail de gasto
      // novo + nudge transparente. Nasce pausada e veicula conforme o creationActivation do agente
      // (v1): "active" ATIVA já (opt-in explícito); "paused" fica pausada + 2º OK. Fallback (não
      // act_full) = só a proposta acima (aprovação humana).
      if (state.autonomyPolicy?.byAction?.[toolKey] === "act_full") {
        const outcome = await autoApplyProactiveDraft(deps, { orgId: state.orgId, draftId: proposal.draftId, approvalId: proposal.approvalId });
        await pushCreationNudge(state, "create_campaign", top.rationale, outcome);
        logger.info({ runId: state.runId, kind: top.kind, outcome: outcome.kind }, "propose_drafts:auto");
      }
    } catch (err) {
      // conflito de throttle (1 proposto proativo/conta) ou falha best-effort → não quebra o run.
      logger.debug({ runId: state.runId, err: String(err) }, "propose_drafts:pulado");
    }
    return {};
  }

  /** Fecha o run (status, summary, partial, custo/usage, metrics_snapshot p/ o site). */
  async function record(state: AccountAnalysisStateType): Promise<AccountAnalysisUpdate> {
    logger.debug({ runId: state.runId }, "record");
    const usage = state.usage;
    await repo.closeRun(state.orgId, state.runId, {
      status: "succeeded",
      summary: state.summary ?? null,
      narrative: state.narrative ?? null,
      partial: state.partial ?? false,
      partialReasons: [...(state.partialReasons ?? [])],
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
    return hadFailure ? { results, partial: true, partialReasons: ["action_apply" as const] } : { results };
  }

  /**
   * Redator (papel dedicado). Produz DUAS coisas: (1) a NARRATIVA voiceada da análise
   * (SEMPRE que há análise — persistida no run p/ o site, aplica a postura); (2) a
   * ENTREGA no WhatsApp (`outboundMessage`), gated por cron/signal+runPush OU origem
   * WhatsApp (cron/signal sem recomendação = silêncio; WhatsApp sempre responde). O
   * nudge de volume + notas de aplicadas/pendentes vão SÓ na entrega (o site mostra
   * tudo nos cards). LLM barato + persona; fallback determinístico do core em erro/JSON.
   */
  async function writeMessage(state: AccountAnalysisStateType): Promise<AccountAnalysisUpdate> {
    logger.debug({ runId: state.runId }, "write_message");
    const isWhatsapp = state.notifyTarget != null; // run disparado pelo WhatsApp → responde na conversa
    // cron/signal (F4) + on-demand do site empurram ao alvo org-level (grupo ativo, senão DM).
    // on_demand PRECISA pushar: o site promete "te aviso no WhatsApp quando terminar" (a tela diz
    // "pode fechar"), então o resultado do "Analisar agora" tem de chegar ao WhatsApp.
    const notifiesOrg =
      state.trigger === "cron" || state.trigger === "signal" || state.trigger === "on_demand";
    // runPush (F4) desliga o push de RUN (cron/on-demand); signal tem gate próprio (alerts).
    const isRunPush = state.trigger === "cron" || state.trigger === "on_demand";
    // Transparência (S7, geral): se o run APLICOU ação REAL sozinho (autonomia), o aviso NÃO pode
    // sumir mesmo com runPush OFF — a mensagem do run já resume as aplicadas. runPush governa o
    // resumo da ANÁLISE, não a transparência de mudança real na conta.
    const appliedRealActions = !state.guardrailConfig.dryRun && (state.results?.length ?? 0) > 0;
    const runPushOff = isRunPush && state.notifyPolicy?.runPush.enabled === false && !appliedRealActions;
    const out = state.analysisOutput;
    if (!out || !state.account) {
      // conta zerada (brief vazio): cron/signal = silêncio; on-demand/chat = empty-state
      // útil + oferta de ligar a reativação (só quando está OFF — evita oferta redundante).
      const emptyDeliver = isWhatsapp || (state.trigger === "on_demand" && !runPushOff);
      if (state.account && emptyDeliver) {
        const offer = state.notifyPolicy?.reactivation?.enabled !== true;
        return { outboundMessage: buildNoActivityMessage(state.account.name, offer), narrative: null, offersReactivation: offer };
      }
      return { outboundMessage: null, narrative: null }; // sem análise → nada a renderizar
    }

    const cfg = state.analysisConfig ?? deps.analysis;
    const posture = state.posture ?? DEFAULT_POSTURE;
    const hasRecs = out.recommendations.length > 0;

    // ── (1) NARRATIVA (SEMPRE): a voz do agente sobre a análise, p/ o site + WhatsApp ──
    let narrative: string;
    let usage = state.usage;
    if (hasRecs) {
      let text: string | null = null;
      try {
        const completion = await deps.ports.llm.completeStructured<{ text: string }>({
          model: cfg.messageModel,
          messages: buildMessageMessages(state.systemPrompt, state.account.name, out, posture, {
            ...(state.brief?.waste ? { waste: state.brief.waste } : {}),
            ...(state.brief?.trackingHealth?.suspect ? { trackingSuspect: true } : {}),
            atBudgetCeilingCampaigns: campaignsAtBudgetCeiling(state.brief?.segments.campaigns ?? []),
            ...(state.brief?.funnel ? { funnel: state.brief.funnel } : {}),
          }, state.vertical),
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
      narrative =
        text ??
        buildMessageFallback(
          {
            accountName: state.account.name,
            currency: state.account.currency,
            ...(out.scorecard?.headline ? { headline: out.scorecard.headline } : {}),
            summary: out.summary,
            // filtra insights ANTES de fatiar (mesma base do redator + do nudge de volume).
            recommendations: out.recommendations
              .filter((r) => kindForRecommendation(r.actionType) !== "insight")
              .map((r) => ({ title: r.title })),
            ...(state.brief?.waste && state.brief.waste.wastedSpend > 0
              ? { money: { wastedSpend: state.brief.waste.wastedSpend, wastedPct: state.brief.waste.wastedPct } }
              : {}),
          },
          volumeToRecCount(posture.volume),
        );
    } else {
      const headline = out.scorecard?.headline ?? out.summary;
      narrative = `Analisei a conta ${state.account.name}. ${headline} Nada crítico pra mexer agora — sigo de olho.`;
    }

    // ── (2) ENTREGA (push): gated. cron/signal sem recomendação = silêncio; WhatsApp sempre ──
    const shouldDeliver = isWhatsapp || (notifiesOrg && !runPushOff);
    let outbound: string | null = null;
    if (shouldDeliver && (hasRecs || isWhatsapp)) {
      outbound = narrative;
      // nudge de volume: o push LIDERA com N (volume); se sobram sugestões materiais,
      // oferece ver o resto (o chat lista todas via list_recommendations). Só na entrega.
      if (hasRecs) {
        const surfaceable = out.recommendations.filter((r) => kindForRecommendation(r.actionType) !== "insight");
        const more = surfaceable.length - volumeToRecCount(posture.volume);
        if (more > 0) outbound = `${outbound}\n\nTem mais ${more} sugestão(ões) — quer ver?`;
      }
      // nota honesta do que o agente FEZ neste run (aplicou/simulou) — determinística.
      const attempted = state.guardrail?.allowed.length ?? 0;
      const applied = appliedSummary(state.results?.length ?? 0, attempted, state.guardrailConfig.dryRun);
      if (applied) outbound = `${outbound}\n\n${applied}`;
      // bridge do HITL (5b-2): avisa que há pendentes + dá pra aprovar por aqui/site.
      const pending = state.approvalCandidates?.length ?? 0;
      if (pending > 0) {
        outbound = `${outbound}\n\n🔔 ${pending} ação(ões) aguardando seu OK. Responda por aqui pra aprovar/rejeitar, ou veja no site.`;
      }
    }
    return { outboundMessage: outbound, narrative, usage };
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

    // alvo: WhatsApp-origin (DM ou grupo) → quem pediu; cron/signal → alvo org-level
    // (grupo ativo se houver, senão DM — G2).
    const ref = state.notifyTarget?.ref ?? (await notifyRepo.loadTarget(state.orgId));
    if (!ref) {
      logger.warn({ orgId: state.orgId, runId: state.runId }, "notify:sem canal/contato — sem push");
      return {};
    }

    const link = `${deps.webOrigin}/accounts/${state.adAccountId}`;
    const text = `${body}\n\nVer no site: ${link}`;
    // chat (push do WhatsApp) quebra em blocos; cron enxuto (1 msg) — ban-safety §9.
    const sent = await sendToConversation(ref, text, {
      split: state.notifyTarget != null,
      meta: { runId: state.runId },
    });
    if (!sent) logger.warn({ runId: state.runId }, "notify:envio falhou/sem instância — sem push");
    // Empty-state com oferta de reativação empurrado ao alvo ORG-LEVEL (não uma resposta de
    // WhatsApp-origin): foca a conta-alvo na conversa, pra o "sim" do dono resolver naquela conta
    // e conseguir ligar a reativação por chat — senão, em org multi-conta, cairia no concierge
    // sem config ("é no site") e a oferta seria vazia (contradição achada no E2E ao vivo).
    if (sent && state.offersReactivation && state.notifyTarget == null) {
      await notifyRepo.focusForRef(state.orgId, ref, state.adAccountId).catch((err) =>
        logger.warn({ runId: state.runId, err: String(err) }, "notify:focus-on-offer degradou"),
      );
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
    proposeDrafts: step("propose_drafts", proposeDrafts),
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
/**
 * systemPrompt do ANALISTA: a voz base + a nota do sinal (F4, `describeSignal`) quando
 * o run foi disparado por sinal — DIRIGE o olhar do analista sem vazar pro redator do
 * WhatsApp (que usa `state.systemPrompt` limpo).
 */
function analystPrompt(state: AccountAnalysisStateType): string {
  return state.signalFinding ? `${state.systemPrompt}\n\n${describeSignal(state.signalFinding)}` : state.systemPrompt;
}

function decideDeepRun(
  trigger: AccountAnalysisStateType["trigger"],
  adUnits: readonly EntitySummary[],
  last: ReadonlyMap<string, LastEntityAnalysis>,
  deepIntervalDays: number,
  configChangedAt: number | null,
): boolean {
  if (trigger === "on_demand") return true;
  if (trigger === "signal") return true; // alerta (F4): análise fresca sobre o ponto sinalizado.
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
      // conversão de NEGÓCIO usada no CPA da conta (rótulo honesto no site;
      // ausente = CPA por objetivo da entidade → rótulo genérico "resultado").
      ...(state.goals.conversionGoal ? { conversionGoal: state.goals.conversionGoal } : {}),
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
      ...(u.campaign.budget ? { budget: u.campaign.budget } : {}),
      ...(u.campaign.atBudgetCeiling !== undefined ? { atBudgetCeiling: u.campaign.atBudgetCeiling } : {}),
      isCBO: u.campaign.budget != null,
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

/**
 * Recomendação do LLM → linha persistível. Antes DESCARTAVA as consultivas (viravam
 * `proposedAction=null` sem rótulo); agora classifica em `kind` (S2): as executáveis
 * viram `platform_action` (com `toolKey` = capacidade do catálogo), as de revisão
 * viram `human_direction`, e "manter" vira `insight`. Uma `platform_action` que não
 * materializa a ação (alvo inválido / budget sem pct) é rebaixada a `human_direction`
 * — honesto: aparece, mas sem CTA de aplicar (invariante: platform_action ⟺ ação).
 */
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
  const baseKind = kindForRecommendation(rec.actionType);
  const kind =
    baseKind === "platform_action" && proposedAction === null ? "human_direction" : baseKind;
  const toolKey = kind === "platform_action" && proposedAction ? proposedAction.type : null;
  return {
    orgId,
    runId,
    title: rec.title,
    rationale: rec.rationale,
    kind,
    proposedAction,
    toolKey,
    // risco atrelado ao KIND: só platform_action (com ação real) carrega risco; direção/
    // insight (sem CTA de aplicar) são sempre "low" — o rótulo não pode sugerir perigo.
    riskLevel: kind === "platform_action" && actionType ? riskForAction(actionType, params) : "low",
    // taxonomia de saída (S0b/G4) — repassa verbatim (já validado pelo zod: null quando o
    // LLM não conseguiu ancorar em dado real).
    expectedImpact: rec.expectedImpact,
    whatToMonitor: rec.whatToMonitor,
    findingRefs: rec.findingRefs,
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

/** Ações que ADICIONAM investimento/exposição (mesmo Set de `SCALE_ACTIONS` em analysis-guards). */
const SCALE_ACTION_TYPES = new Set(["increase_budget", "resume"]);

/**
 * Resolve o teto de escala por audiência (Fase 4) — REATIVO: só chama `deliveryEstimate`
 * pros adsets que JÁ têm proposta de escalar SOBREVIVENDO aos guards anteriores neste run
 * (nunca varre a conta à toa). Escopo restrito a `targetEntity.level === "adset"` (campanha
 * CBO pode ter N adsets com públicos distintos — ambíguo demais pra 1 estimativa só).
 * Melhor esforço: falha por entidade → fica de fora do mapa (guard passa direto, honesto).
 */
async function resolveAudienceHeadroomByEntity(
  ioDeps: { repo: AnalysisRepo; ads: AdsPlatformPort; vault: WorkerDeps["ports"]["vault"]; logger: WorkerDeps["logger"] },
  state: AccountAnalysisStateType,
  output: AnalysisOutput,
  cfg: ResolvedAnalysisConfig,
): Promise<Map<string, AudienceHeadroom>> {
  const headroomByEntity = new Map<string, AudienceHeadroom>();
  const targetIds = new Set(
    output.recommendations
      .filter((r) => SCALE_ACTION_TYPES.has(r.actionType) && r.targetEntity?.level === "adset")
      .map((r) => r.targetEntity!.externalId),
  );
  if (targetIds.size === 0 || !state.brief) return headroomByEntity;

  const account = await ioDeps.repo.loadAccount(state.orgId, state.adAccountId);
  if (!account) return headroomByEntity;
  const accessToken = ioDeps.vault.decrypt(account.tokenCripto);
  const ref = { adAccountId: account.metaAdAccountId, accessToken };
  const adsetById = new Map(state.brief.segments.adsets.map((e) => [e.id, e]));

  for (const entityId of targetIds) {
    const entity = adsetById.get(entityId);
    if (!entity) continue;
    try {
      const estimate = await ioDeps.ads.getDeliveryEstimateForAdSet(ref, entityId);
      if (!estimate.ready) continue;
      const monthlyReach =
        estimate.monthlyReachMin !== undefined && estimate.monthlyReachMax !== undefined
          ? (estimate.monthlyReachMin + estimate.monthlyReachMax) / 2
          : (estimate.monthlyReachMax ?? estimate.monthlyReachMin ?? estimate.dailyActiveUsers);
      if (monthlyReach === undefined) continue;
      headroomByEntity.set(entityId, {
        monthlyReach,
        currentMonthlyImpressions: (entity.metrics.impressions / cfg.windowDays) * 30,
        frequencyCap: resolveFrequencyCap(entity.audience?.stage, cfg.quality),
      });
    } catch (err) {
      ioDeps.logger.warn({ runId: state.runId, entityId, err: String(err) }, "review_analysis:delivery_estimate degradou (guard passa direto)");
    }
  }
  return headroomByEntity;
}

/** Params da ação de budget (direção + magnitude), quando for o caso. `pct` sempre ≥0. */
function budgetParams(rec: AnalysisRecommendation): Record<string, unknown> {
  const dir = budgetDirection(rec.actionType);
  if (dir && typeof rec.budgetChangePct === "number" && Number.isFinite(rec.budgetChangePct)) {
    return { [ACTION_PARAM_MODE]: dir, [ACTION_PARAM_PCT]: Math.abs(rec.budgetChangePct) };
  }
  return {};
}
