import { describe, expect, it, vi } from "vitest";
import type { Action, AdEntity, EncryptedPayload, InsightRow } from "@trafego/shared";
import type { ExecuteActionInput } from "../../executors/meta-tools.js";
import type { WorkerDeps } from "../../composition.js";
import type { AnalysisRepo, ConversionLabelRow, RecommendationRow } from "../../modules/analysis/repo.js";
import type { InsightsSnapshotsRepo } from "../../modules/insights/repo.js";
import type { EntityAnalysesRepo, LastEntityAnalysis } from "../../modules/analysis/entity-analyses.repo.js";
import type { NotifyRepo } from "../../modules/notify/repo.js";
import { AnalysisError } from "../../modules/analysis/errors.js";
import { makeAccountAnalysisNodes } from "./nodes.js";
import type { AccountAnalysisStateType, AccountAnalysisUpdate } from "./state.js";

const TOKEN: EncryptedPayload = { ciphertext: "ct", iv: "iv", tag: "tg", keyVersion: 1 };

function row(entityId: string, level: InsightRow["level"], spend: number, purchases?: number): InsightRow {
  return {
    entityId,
    level,
    date: "2026-08-15",
    metrics: { spend, impressions: 1000, clicks: 50, ctr: 0, cpc: 0, cpm: 0 },
    ...(purchases ? { conversions: [{ goal: "purchase", count: purchases, value: purchases * 100 }] } : {}),
  };
}

const ENTITIES: AdEntity[] = [
  { id: "c1", level: "campaign", name: "Campanha 1", status: "active", objective: { goal: "purchase" } },
];

// Output combinado: válido p/ analysisOutputSchema (síntese/revisor) E p/
// unitAnalysisSchema (mapa) — cada schema descarta os campos que não conhece
// (scorecard no unit; flags no analysis). Deixa o mock único servir os dois papéis.
const ANALYSIS_OUTPUT = {
  scorecard: { grade: "C", headline: "CPA acima da meta na campanha principal.", biggestLeak: "conversao" },
  summary: "Conta gastou R$300; CPA acima da meta na Campanha 1.",
  flags: [],
  findings: [{ id: "f1", title: "CPA alto", detail: "R$100/venda", severity: "warning", metricRefs: [{ label: "CPA", value: 100 }], caveat: null }],
  recommendations: [
    { id: "r1", title: "Pausar Campanha 1", rationale: "CPA 2x a meta", priority: "high", actionType: "pause", targetEntity: { level: "campaign", externalId: "c1" }, budgetChangePct: null, expectedImpact: null, whatToMonitor: null, findingRefs: null },
    { id: "r2", title: "Revisar criativo", rationale: "Fadiga", priority: "medium", actionType: "review_creative", targetEntity: null, budgetChangePct: null, expectedImpact: null, whatToMonitor: null, findingRefs: null },
    { id: "r3", title: "Pausar fantasma", rationale: "id inexistente", priority: "low", actionType: "pause", targetEntity: { level: "ad", externalId: "ZZZ" }, budgetChangePct: null, expectedImpact: null, whatToMonitor: null, findingRefs: null },
  ],
};

interface Harness {
  deps: WorkerDeps;
  saved: RecommendationRow[];
  savedLabels: ConversionLabelRow[];
  closed: { status: string; summary: string | null; narrative: string | null; costSnapshot: number | null }[];
  llm: ReturnType<typeof vi.fn>;
  readEntityState: ReturnType<typeof vi.fn>;
  /** inserts CRUS via `deps.db.insert(recommendations).values(v)` (fora do repo — proposeDrafts). */
  insertedRecommendations: Record<string, unknown>[];
  /** ids marcados via `entityAnalysesRepo.markDeactivated` (sincronização — achado real). */
  markedDeactivated: string[];
}

interface HarnessOpts {
  rows?: InsightRow[];
  tokenInvalid?: boolean;
  entities?: AdEntity[];
  goals?: Record<string, unknown>;
  configChangedAt?: Date | null;
  last?: Map<string, LastEntityAnalysis>;
  autonomy?: { bySource: { playbook: "notify" | "suggest" | "act_safe" | "act_full"; llm: "notify" | "suggest" | "act_safe" | "act_full" } };
  guardrail?: { maxBudgetChangePct: number; maxEntitiesPerDay: number; allowedActions: ("pause_entity" | "resume_entity" | "adjust_budget" | "set_status")[]; dryRun: boolean; killSwitch: boolean };
  executor?: { execute: ReturnType<typeof vi.fn> };
  /** estado FRESCO (Meta) devolvido pela releitura pontual do no-op (5b). */
  freshEntityState?: Record<string, unknown>;
  /** F4 runPush: desliga o push de run (cron/on-demand). Default ON. */
  runPushEnabled?: boolean;
  /** S4: perfil vertical do agente. Default "health" (todo o beta hoje é saúde). */
  vertical?: string;
  /** sincronização (achado real): ids de campanha já cacheados ANTES deste run. */
  previouslyCachedCampaignIds?: string[];
  /** simula `listEntities` falhando pra esses níveis (→ partialReasons inclui "entities"). */
  entitiesThrowLevels?: string[];
}

function makeHarness(opts: HarnessOpts = {}): Harness {
  const saved: RecommendationRow[] = [];
  const savedLabels: ConversionLabelRow[] = [];
  const closed: Harness["closed"] = [];
  const rows = opts.rows ?? [row("act_1", "account", 300, 5), row("c1", "campaign", 300, 3)];
  const entities = opts.entities ?? ENTITIES;
  const byLevel = (level: string) => entities.filter((e) => e.level === level);

  const repo: AnalysisRepo = {
    loadAgentContext: vi.fn(async () => ({ goals: opts.goals ?? { targetCPA: 50 }, archetype: "conservador", vertical: opts.vertical ?? "health", timezone: "America/Sao_Paulo", systemPrompt: null, persona: null, tone: null, businessContext: null, guidance: null, configChangedAt: opts.configChangedAt ?? null, modelConfig: {}, autonomyPolicy: opts.autonomy ?? { bySource: { playbook: "suggest" as const, llm: "suggest" as const } }, notifyPolicy: { pulse: { enabled: false, cadence: { kind: "daily" as const, hour: 8 } }, alerts: { enabled: false, sensitivity: "normal" as const, throttleHours: 6 }, runPush: { enabled: opts.runPushEnabled ?? true }, reactivation: { enabled: false } }, posture: { directiveness: "consultative" as const, volume: "balanced" as const, didacticDepth: "explanatory" as const, experienceLevel: null }, guardrailConfig: opts.guardrail ?? { maxBudgetChangePct: 20, maxEntitiesPerDay: 3, allowedActions: ["pause_entity" as const], dryRun: true, killSwitch: false }, playbook: [], rejectedMemory: [], mutedCampaignIds: [], orgMarketReference: null })),
    loadAccount: vi.fn(async () => ({ metaAdAccountId: "act_1", name: "Conta", currency: "BRL", tokenCripto: TOKEN })),
    openRun: vi.fn(async () => {}),
    markTokenInvalid: vi.fn(async () => {}),
    saveRecommendations: vi.fn(async (r: readonly RecommendationRow[]) => { saved.push(...r); }),
    saveAdCreatives: vi.fn(async () => {}),
    saveAdCreativeCopies: vi.fn(async () => {}),
    saveCustomAudiences: vi.fn(async () => {}),
    saveConversionLabels: vi.fn(async (_o, _a, _p, labels: readonly ConversionLabelRow[]) => { savedLabels.push(...labels); }),
    consumeConfigChanged: vi.fn(async () => {}),
    loadDailyToolContext: vi.fn(async () => ({ touchedToday: new Set<string>(), budgetChangedToday: new Set<string>() })),
    recordStep: vi.fn(async () => {}),
    closeRun: vi.fn(async (_o, _r, input) => { closed.push({ status: input.status, summary: input.summary, narrative: input.narrative ?? null, costSnapshot: input.costSnapshot }); }),
  };
  const snapshots: InsightsSnapshotsRepo = {
    latestDate: vi.fn(async () => null),
    upsertMany: vi.fn(async () => {}),
    listWindow: vi.fn(async () => rows),
    latestSyncedAtByAccounts: vi.fn(async () => new Map()),
    accountActivitySince: vi.fn(async () => false),
  };
  const markedDeactivated: string[] = [];
  const entityAnalyses: EntityAnalysesRepo = {
    loadByAgent: vi.fn(async () => opts.last ?? new Map<string, LastEntityAnalysis>()),
    saveMany: vi.fn(async () => {}),
    loadCampaignIds: vi.fn(async () => new Set(opts.previouslyCachedCampaignIds ?? [])),
    markDeactivated: vi.fn(async (_agentId: string, ids: readonly string[]) => {
      markedDeactivated.push(...ids);
    }),
  };
  // no cron o chain chega ao notify (usa db real) — fake short-circuita o envio.
  const notify: NotifyRepo = {
    alreadyNotified: vi.fn(async () => true),
    loadTarget: vi.fn(async () => null),
    focusForRef: vi.fn(async () => {}),
    resolveInboundContact: vi.fn(async () => null),
    alreadyProcessed: vi.fn(async () => false),
    lastInboundForQuote: vi.fn(async () => null),
    ensureConversation: vi.fn(async () => "conv-1"),
    recordMessage: vi.fn(async () => "msg-1"),
    updateMessageContent: vi.fn(async () => {}),
    contextAdAccountId: vi.fn(async () => null),
    resolveOutboundTarget: vi.fn(async () => null),
    updateInstanceStatus: vi.fn(async () => {}),
    instancePhone: vi.fn(async () => null),
    resolveInboundGroup: vi.fn(async () => null),
    ensureGroupConversation: vi.fn(async () => "conv-1"),
    recordGroupMessage: vi.fn(async () => undefined),
    loadGroupTranscriptSources: vi.fn(async () => []),
    purgeGroupMessagesBefore: vi.fn(async () => 0),
    resolveGroupTarget: vi.fn(async () => null),
  };
  const llm = vi.fn(async () => ({ output: ANALYSIS_OUTPUT, usage: { inputTokens: 100, outputTokens: 20, costUsd: 0.001 } }));
  const readEntityState = vi.fn(async () => opts.freshEntityState ?? { status: "ACTIVE", effective_status: "ACTIVE" });

  // db falso mínimo: loadEnabledTools (load_context) faz 1 select em agent_tool_bindings —
  // sem bindings → resolveEnabledTools cai no fallback (allowedActions do guardrailConfig).
  // `insert` cobre o insert CRU de `proposeDrafts` (recommendations `human_direction`, P1.1) —
  // fora do repo (o resto do harness passa pelo AnalysisRepo acima).
  const emptySelect = { from: () => ({ where: async () => [] }) };
  const insertedRecommendations: Record<string, unknown>[] = [];
  const deps = {
    db: {
      select: () => emptySelect,
      insert: () => ({ values: async (v: Record<string, unknown>) => { insertedRecommendations.push(v); } }),
    } as never,
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
    redis: {} as never,
    ports: {
      ads: {
        listEntities: vi.fn(async (_ref, level) => {
          if (opts.entitiesThrowLevels?.includes(level)) throw new Error("Meta indisponível (simulado)");
          return byLevel(level);
        }),
        getCreatives: vi.fn(async () => []),
        readEntityState,
      } as never,
      messaging: {} as never,
      llm: { completeStructured: llm, complete: vi.fn() } as never,
      vault: { decrypt: vi.fn(() => "tok"), encrypt: vi.fn() } as never,
      scheduler: {} as never,
      metering: {} as never,
      approval: {} as never,
    },
    insightsSync: { sync: vi.fn(async () => ({ partial: false, tokenInvalid: opts.tokenInvalid ?? false, snapshotsWritten: rows.length })) } as never,
    breakdownSync: { sync: vi.fn(async () => ({ synced: false })) } as never,
    analysis: {
      model: "m",
      reviewModel: "review-m",
      unitModel: "m",
      unitFallbackModels: [],
      messageModel: "m",
      visionModel: "m",
      windowDays: 7,
      baselineDays: 7,
      topN: 5,
      reviewEnabled: true,
      maxOutputTokens: 4000,
      reasoningEffort: "medium",
      reviewReasoningEffort: "off",
      maxCreativesVision: 8,
      notableAdsPerCampaign: 5,
      maxCreativesVisionPerCampaign: 3,
      mapConcurrency: 4,
      executionPolicy: "deep_periodic_incremental",
      deepIntervalDays: 7,
      materialChangePct: 15,
      quality: {
        minConversions: 20,
        minClicks: 100,
        fatigueCtrDropPct: 20,
        fatigueFrequency: 3,
        frequencyCapByStage: { prospecting: 2.5, remarketing: 8 },
        fatigueCostRisePct: 30,
        zombieMinSpend: 50,
        coldStartReference: true,
        trackingBrokenRatio: 50,
        trackingBrokenMinFunnel: 50,
        relativeEligibilitySpendMultiplier: 2,
        marginalCpaWorsenPct: 20,
      },
    },
    webOrigin: "https://app.example.com",
    cron: { defaultCron: "0 8 * * *", tz: "America/Sao_Paulo", jitterMs: 0 },
    learning: {
      historyRuns: 10,
      minRuns: 3,
      minOccurrenceRatio: 0.6,
      briefTopK: 5,
      redactorModel: "m",
      redactorMaxPerTick: 20,
      phaseBufferDays: 7,
      outcomeWindowDays: 7,
      decayStaleDays: 30,
      decayArchiveDays: 60,
    },
    checkpointer: undefined as never, // grafo A é linear (sem checkpointer)
  } as unknown as WorkerDeps;

  const learning = { loadActiveLessons: vi.fn(async () => []), saveEntityConfigSnapshots: vi.fn(async () => {}) };
  const nodesWithFakes = { repo, snapshots, entityAnalyses, notify, learning, ...(opts.executor ? { executor: opts.executor } : {}) };
  // guarda os fakes p/ o teste montar os nós
  (deps as unknown as { _repos: typeof nodesWithFakes })._repos = nodesWithFakes;
  return { deps, saved, savedLabels, closed, llm, readEntityState, insertedRecommendations, markedDeactivated };
}

/** Nº de chamadas de LLM do MAPA (por-campanha) — identificadas por meta.type "unit". */
function unitCalls(llm: ReturnType<typeof vi.fn>): number {
  return llm.mock.calls.filter((c) => (c[0] as { meta?: { type?: string } })?.meta?.type === "unit").length;
}

/** Roda a cadeia read-only, mesclando os patches (simula o StateGraph). */
async function runChain(h: Harness, trigger: "cron" | "on_demand" = "on_demand"): Promise<AccountAnalysisStateType> {
  const repos = (h.deps as unknown as { _repos: Parameters<typeof makeAccountAnalysisNodes>[1] })._repos;
  const n = makeAccountAnalysisNodes(h.deps, repos);
  let state = {
    runId: "run-1",
    orgId: "org-1",
    agentId: "agent-1",
    adAccountId: "acc-uuid",
    trigger,
  } as unknown as AccountAnalysisStateType;
  const apply = (patch: AccountAnalysisUpdate) => { state = { ...state, ...patch } as AccountAnalysisStateType; };

  apply(await n.loadContext(state));
  apply(await n.fetchData(state));
  apply(await n.runPlaybook(state));
  apply(await n.mapUnits(state));
  apply(await n.synthesize(state));
  apply(await n.reviewAnalysis(state));
  apply(await n.buildRecommendations(state));
  apply(await n.decideActions(state));
  apply(await n.guardrailCheck(state));
  apply(await n.applyActions(state));
  apply(await n.writeMessage(state));
  apply(await n.record(state));
  apply(await n.notify(state));
  return state;
}

describe("account-analysis read-only nodes", () => {
  it("happy path: analisa, mapeia recomendações e fecha o run", async () => {
    const h = makeHarness();
    await runChain(h);

    // 1 mapa (c1) + síntese + revisor + REDATOR (narrativa renderada SEMPRE, inclusive
    // on-demand — S4) → 4 chamadas de LLM.
    expect(h.llm).toHaveBeenCalledTimes(4);
    // narrativa voiceada persistida no run (o site exibe no topo).
    expect(typeof h.closed[0]?.narrative).toBe("string");
    expect((h.closed[0]?.narrative ?? "").length).toBeGreaterThan(0);
    // 3 recomendações persistidas
    expect(h.saved).toHaveLength(3);
    // r1 (pause, id válido) → proposedAction tipado
    const r1 = h.saved.find((r) => r.title.includes("Pausar Campanha"));
    expect(r1?.proposedAction?.type).toBe("pause_entity");
    expect(r1?.proposedAction?.target.id).toBe("c1");
    expect(r1?.riskLevel).toBe("low");
    // r2 (consultiva) → sem ação tipada
    const r2 = h.saved.find((r) => r.title.includes("Revisar"));
    expect(r2?.proposedAction).toBeNull();
    // r3 (id inexistente) → não vira ação (anti-alucinação)
    const r3 = h.saved.find((r) => r.title.includes("fantasma"));
    expect(r3?.proposedAction).toBeNull();
    // run fechado com sucesso + custo
    expect(h.closed).toHaveLength(1);
    // usage: mapa + síntese + revisor (0.001 cada). O redator É chamado (4ª call), mas o
    // mock devolve o objeto de análise (sem .text) → cai no fallback e NÃO soma usage
    // (usage só entra com texto válido). Em produção o redator retorna texto e somaria.
    expect(h.closed[0]).toMatchObject({ status: "succeeded", costSnapshot: 0.003 });
  });

  it("sincronização: campanha cacheada que sumiu do conjunto ativo → marcada como desativada", async () => {
    const h = makeHarness({ previouslyCachedCampaignIds: ["c1", "c-fantasma"] });
    await runChain(h);
    // c1 continua ativa (está em ENTITIES) → não marcada; c-fantasma sumiu → marcada.
    expect(h.markedDeactivated).toEqual(["c-fantasma"]);
  });

  it("sincronização: nada sumiu (só o que já era esperado) → não marca nada", async () => {
    const h = makeHarness({ previouslyCachedCampaignIds: ["c1"] });
    await runChain(h);
    expect(h.markedDeactivated).toEqual([]);
  });

  it("sincronização: listagem de campanha PARCIAL (Meta falhou) → NUNCA marca (evita falso-positivo)", async () => {
    const h = makeHarness({ previouslyCachedCampaignIds: ["c1", "c-fantasma"], entitiesThrowLevels: ["campaign"] });
    await runChain(h);
    // c1 "sumiria" do catálogo (fetch falhou), mas como a listagem foi parcial, nada é marcado —
    // marcar aqui arriscaria dizer que uma campanha ainda ativa "desativou" só por falha de rede.
    expect(h.markedDeactivated).toEqual([]);
  });

  it("on_demand (site): compõe push pro WhatsApp — honra 'te aviso quando terminar'", async () => {
    const h = makeHarness();
    const state = await runChain(h, "on_demand");
    // regressão: on_demand NÃO pushava (outboundMessage null); agora entrega ao alvo org-level.
    expect(typeof state.outboundMessage).toBe("string");
    expect((state.outboundMessage ?? "").length).toBeGreaterThan(0);
  });

  it("on_demand + runPush OFF: opt-out silencia o push (narrativa segue pro site)", async () => {
    const h = makeHarness({ runPushEnabled: false });
    const state = await runChain(h, "on_demand");
    expect(state.outboundMessage).toBeNull();
    // a narrativa do site é independente da entrega — continua renderizada.
    expect(typeof state.narrative).toBe("string");
    expect((state.narrative ?? "").length).toBeGreaterThan(0);
  });

  it("auto-apply: act_full + guardrail libera → executor aplica a ação do LLM", async () => {
    const execute = vi.fn(async (i: { action: Action }) => ({ result: { action: i.action, before: {}, after: {} }, dryRun: false, replayed: false }));
    const h = makeHarness({
      autonomy: { bySource: { playbook: "suggest", llm: "act_full" } },
      guardrail: { maxBudgetChangePct: 20, maxEntitiesPerDay: 3, allowedActions: ["pause_entity"], dryRun: false, killSwitch: false },
      executor: { execute },
    });
    const state = await runChain(h);
    // r1 (pausar c1, alvo válido) auto-aplicada; r3 (id fantasma) nunca virou ação.
    expect(execute).toHaveBeenCalledTimes(1);
    expect((execute.mock.calls[0]![0] as ExecuteActionInput).action.target.id).toBe("c1");
    expect((execute.mock.calls[0]![0] as ExecuteActionInput).dryRun).toBe(false);
    expect(state.results).toHaveLength(1);
  });

  it("dry_run: simula (executor recebe dryRun=true)", async () => {
    const execute = vi.fn(async (i: { action: Action }) => ({ result: { action: i.action, before: {}, after: {} }, dryRun: true, replayed: false }));
    const h = makeHarness({
      autonomy: { bySource: { playbook: "suggest", llm: "act_full" } },
      guardrail: { maxBudgetChangePct: 20, maxEntitiesPerDay: 3, allowedActions: ["pause_entity"], dryRun: true, killSwitch: false },
      executor: { execute },
    });
    await runChain(h);
    expect((execute.mock.calls[0]![0] as ExecuteActionInput).dryRun).toBe(true);
  });

  it("tipo fora de allowed_actions → guardrail dropa, executor não é chamado", async () => {
    const execute = vi.fn();
    const h = makeHarness({
      autonomy: { bySource: { playbook: "suggest", llm: "act_full" } },
      guardrail: { maxBudgetChangePct: 20, maxEntitiesPerDay: 3, allowedActions: [], dryRun: false, killSwitch: false },
      executor: { execute },
    });
    await runChain(h);
    expect(execute).not.toHaveBeenCalled();
  });

  it("suggest (default) → nada auto-aplica; sugestão vai pro snapshot", async () => {
    const execute = vi.fn();
    const h = makeHarness({ executor: { execute } });
    const state = await runChain(h);
    expect(execute).not.toHaveBeenCalled();
    expect(state.decision?.needApproval.length).toBeGreaterThan(0);
  });

  it("map-reduce: analisa por-campanha (árvore adset+ad), sintetiza, revisa e persiste a unidade", async () => {
    const entities: AdEntity[] = [
      { id: "c1", level: "campaign", name: "Campanha 1", status: "active", objective: { goal: "purchase" } },
      { id: "as1", level: "adset", name: "Conjunto 1", status: "active", campaignId: "c1" },
      { id: "a1", level: "ad", name: "Anúncio 1", status: "active", campaignId: "c1", adsetId: "as1" },
    ];
    const rows = [
      row("act_1", "account", 300, 5),
      row("c1", "campaign", 300, 3),
      row("as1", "adset", 300, 3),
      row("a1", "ad", 300, 3),
    ];
    const h = makeHarness({ entities, rows });
    const repos = (h.deps as unknown as { _repos: { entityAnalyses: EntityAnalysesRepo } })._repos;
    await runChain(h);

    // 1 mapa (c1) + 1 síntese + 1 revisor + 1 redator (narrativa sempre — S4) = 4 chamadas
    expect(h.llm).toHaveBeenCalledTimes(4);
    // reviewer DESACOPLADO do synthesis: síntese usa o modelo forte (`model`), revisão o barato (`reviewModel`).
    const modelByType = (type: string): unknown =>
      h.llm.mock.calls.find((c) => (c[0] as { meta?: { type?: string } })?.meta?.type === type)?.[0]?.model;
    expect(modelByType("synthesis")).toBe("m");
    expect(modelByType("review")).toBe("review-m");
    // a análise por-campanha reanalisada é persistida (base do incremental), chaveada por id de campanha
    expect(repos.entityAnalyses.saveMany).toHaveBeenCalledTimes(1);
    const savedUnits = (repos.entityAnalyses.saveMany as ReturnType<typeof vi.fn>).mock.calls[0]?.[2] as {
      entityId: string;
      curated?: { isCBO: boolean; tier?: string };
    }[];
    expect(savedUnits).toHaveLength(1);
    expect(savedUnits[0]?.entityId).toBe("c1");
    // S1: snapshot curado (budget/isCBO/tier/eligibility/etc, já enriquecido por enrichEntitiesQuality
    // antes do mapa) vai junto — sem budget na fixture → isCBO=false.
    expect(savedUnits[0]?.curated?.isCBO).toBe(false);
    expect(savedUnits[0]?.curated?.tier).toBeDefined();
    // recomendações da síntese persistidas
    expect(h.saved.length).toBeGreaterThan(0);
    expect(h.closed[0]?.status).toBe("succeeded");
  });

  it("S4b (achado da revisão — trava o wiring ponta a ponta): visão fraca+baixa persuasão chega no prompt do mapa como weak_creative", async () => {
    const entities: AdEntity[] = [
      { id: "c1", level: "campaign", name: "Campanha 1", status: "active", objective: { goal: "purchase" } },
      { id: "as1", level: "adset", name: "Conjunto 1", status: "active", campaignId: "c1" },
      { id: "a1", level: "ad", name: "Anúncio 1", status: "active", campaignId: "c1", adsetId: "as1" },
    ];
    const rows = [
      row("act_1", "account", 300, 5),
      row("c1", "campaign", 300, 3),
      row("as1", "adset", 300, 3),
      row("a1", "ad", 300, 3),
    ];
    const h = makeHarness({ entities, rows });
    // criativo com imagem (senão creativePosterFrames() fica vazio e a visão nem é chamada).
    (h.deps.ports.ads as unknown as { getCreatives: ReturnType<typeof vi.fn> }).getCreatives = vi.fn(async () => [
      { id: "cr1", adId: "a1", imageUrl: "https://img/1.jpg" },
    ]);
    const repos = (h.deps as unknown as { _repos: Record<string, unknown> })._repos;
    repos.vision = { resolve: vi.fn(async () => ({ summary: "s", strengths: [], weaknesses: [], proofStrength: "weak", persuasionSignals: 1 })) };

    await runChain(h);

    const mapCall = h.llm.mock.calls.find((c) => (c[0] as { meta?: { type?: string } })?.meta?.type === "unit");
    // o array real de healthSignals do anúncio notável fica no USER message (a árvore
    // curada serializada) — checar aí (não o system, onde QUALITY_TEXT já MENCIONA
    // "weak_creative" incondicionalmente pra explicar o vocabulário, o que faria esta
    // asserção passar mesmo se o wiring estivesse quebrado).
    const userMsg = (mapCall?.[0] as { messages: { role: string; content: string }[] }).messages.find((m) => m.role === "user");
    expect(userMsg?.content).toContain("weak_creative");
  });

  it("S8b: campanha ABO com 2+ adsets ativos ganha diagnóstico por-adset DERIVADO (sem LLM extra) — CBO/1-adset continuam só por campanha", async () => {
    const entities: AdEntity[] = [
      { id: "c1", level: "campaign", name: "Campanha 1", status: "active", objective: { goal: "purchase" } },
      { id: "as1", level: "adset", name: "Conjunto 1", status: "active", campaignId: "c1", dailyBudget: 50 },
      { id: "as2", level: "adset", name: "Conjunto 2", status: "active", campaignId: "c1", dailyBudget: 50 },
    ];
    const rows = [
      row("act_1", "account", 300, 5),
      row("c1", "campaign", 300, 3),
      row("as1", "adset", 200, 2),
      row("as2", "adset", 100, 1),
    ];
    const h = makeHarness({ entities, rows });
    const ABO_OUTPUT = {
      scorecard: { grade: "C", headline: "h", biggestLeak: "conversao" },
      summary: "s",
      flags: [],
      findings: [{ id: "f-as1", title: "CPA alto no as1", detail: "d", severity: "warning", metricRefs: [{ label: "CPA", value: 80 }], caveat: null }],
      recommendations: [
        { id: "r-as1", title: "Aumentar orçamento do as1", rationale: "r", priority: "high", actionType: "increase_budget", targetEntity: { level: "adset", externalId: "as1" }, budgetChangePct: 10, expectedImpact: null, whatToMonitor: null, findingRefs: ["f-as1"] },
      ],
    };
    h.llm.mockImplementation(async () => ({ output: ABO_OUTPUT, usage: { inputTokens: 100, outputTokens: 20, costUsd: 0.001 } }));

    await runChain(h);

    const repos = (h.deps as unknown as { _repos: { entityAnalyses: EntityAnalysesRepo } })._repos;
    const savedUnits = (repos.entityAnalyses.saveMany as ReturnType<typeof vi.fn>).mock.calls[0]?.[2] as {
      entityId: string;
      entityLevel: string;
      unit: { recommendations: { id: string }[]; findings: { id: string }[] };
      curated?: { isCBO: boolean };
    }[];
    // campanha (ABO, sem budget próprio) + 2 adsets (cada um com o SEU budget) = 3 linhas.
    expect(savedUnits.map((u) => u.entityId).sort()).toEqual(["as1", "as2", "c1"]);
    const campaignRow = savedUnits.find((u) => u.entityId === "c1")!;
    expect(campaignRow.entityLevel).toBe("campaign");
    expect(campaignRow.curated?.isCBO).toBe(false); // ABO confirmado
    const as1Row = savedUnits.find((u) => u.entityId === "as1")!;
    expect(as1Row.entityLevel).toBe("adset");
    // bug corrigido (revisão final): isCBO é conceito de CAMPANHA — mesmo o adset tendo
    // budget próprio (todo adset ABO tem), isCBO nunca é true num adset (é a campanha-mãe
    // que nunca é CBO nesse cenário, não o adset).
    expect(as1Row.curated?.isCBO).toBe(false);
    expect(as1Row.unit.recommendations.map((r) => r.id)).toEqual(["r-as1"]);
    expect(as1Row.unit.findings.map((f) => f.id)).toEqual(["f-as1"]);
    const as2Row = savedUnits.find((u) => u.entityId === "as2")!;
    expect(as2Row.unit.recommendations).toEqual([]); // nenhuma recomendação mirou as2
  });

  describe("Fase 4 — teto de escala por audiência (reativo)", () => {
    const entities: AdEntity[] = [
      { id: "c1", level: "campaign", name: "Campanha 1", status: "active", objective: { goal: "purchase" } },
      { id: "as1", level: "adset", name: "Conjunto 1", status: "active", campaignId: "c1", dailyBudget: 50 },
      { id: "as2", level: "adset", name: "Conjunto 2", status: "active", campaignId: "c1", dailyBudget: 50 },
    ];
    const rows = [
      row("act_1", "account", 300, 5),
      row("c1", "campaign", 300, 3),
      row("as1", "adset", 200, 2),
      row("as2", "adset", 100, 1),
    ];
    const SCALE_OUTPUT = {
      scorecard: { grade: "C", headline: "h", biggestLeak: "conversao" },
      summary: "s",
      flags: [],
      findings: [{ id: "f-as1", title: "vencedor", detail: "d", severity: "info", metricRefs: [{ label: "CPA", value: 80 }], caveat: null }],
      recommendations: [
        { id: "r-as1", title: "Aumentar orçamento do as1", rationale: "r", priority: "high", actionType: "increase_budget", targetEntity: { level: "adset", externalId: "as1" }, budgetChangePct: 10, expectedImpact: null, whatToMonitor: null, findingRefs: ["f-as1"] },
      ],
    };

    it("público perto do teto (delivery_estimate saturado) → rebaixa increase_budget pra investigate", async () => {
      const h = makeHarness({ entities, rows });
      h.llm.mockImplementation(async () => ({ output: SCALE_OUTPUT, usage: { inputTokens: 100, outputTokens: 20, costUsd: 0.001 } }));
      const getDeliveryEstimateForAdSet = vi.fn(async () => ({ ready: true, monthlyReachMin: 100, monthlyReachMax: 100 }));
      (h.deps.ports.ads as unknown as { getDeliveryEstimateForAdSet: typeof getDeliveryEstimateForAdSet }).getDeliveryEstimateForAdSet = getDeliveryEstimateForAdSet;

      const state = await runChain(h);

      expect(getDeliveryEstimateForAdSet).toHaveBeenCalledWith(expect.anything(), "as1");
      const rec = state.analysisOutput?.recommendations.find((r) => r.id === "r-as1");
      expect(rec?.actionType).toBe("investigate");
      expect(rec?.rationale).toContain("[guard]");
    });

    it("público com folga (delivery_estimate grande) → mantém increase_budget", async () => {
      const h = makeHarness({ entities, rows });
      h.llm.mockImplementation(async () => ({ output: SCALE_OUTPUT, usage: { inputTokens: 100, outputTokens: 20, costUsd: 0.001 } }));
      const getDeliveryEstimateForAdSet = vi.fn(async () => ({ ready: true, monthlyReachMin: 100000, monthlyReachMax: 100000 }));
      (h.deps.ports.ads as unknown as { getDeliveryEstimateForAdSet: typeof getDeliveryEstimateForAdSet }).getDeliveryEstimateForAdSet = getDeliveryEstimateForAdSet;

      const state = await runChain(h);

      const rec = state.analysisOutput?.recommendations.find((r) => r.id === "r-as1");
      expect(rec?.actionType).toBe("increase_budget");
    });

    it("sem proposta de escalar neste run → NUNCA chama delivery_estimate (reativo, custo zero)", async () => {
      const h = makeHarness({ entities, rows }); // ANALYSIS_OUTPUT padrão não escala adset nenhum
      const getDeliveryEstimateForAdSet = vi.fn(async () => ({ ready: true, monthlyReachMin: 1, monthlyReachMax: 1 }));
      (h.deps.ports.ads as unknown as { getDeliveryEstimateForAdSet: typeof getDeliveryEstimateForAdSet }).getDeliveryEstimateForAdSet = getDeliveryEstimateForAdSet;

      await runChain(h);

      expect(getDeliveryEstimateForAdSet).not.toHaveBeenCalled();
    });

    it("delivery_estimate falha (upstream) → degrada graciosamente, mantém a recomendação original", async () => {
      const h = makeHarness({ entities, rows });
      h.llm.mockImplementation(async () => ({ output: SCALE_OUTPUT, usage: { inputTokens: 100, outputTokens: 20, costUsd: 0.001 } }));
      const getDeliveryEstimateForAdSet = vi.fn(async () => { throw new Error("upstream"); });
      (h.deps.ports.ads as unknown as { getDeliveryEstimateForAdSet: typeof getDeliveryEstimateForAdSet }).getDeliveryEstimateForAdSet = getDeliveryEstimateForAdSet;

      const state = await runChain(h);

      const rec = state.analysisOutput?.recommendations.find((r) => r.id === "r-as1");
      expect(rec?.actionType).toBe("increase_budget");
    });
  });

  it("conta parada: pula o LLM e conclui com nota 'sem atividade'", async () => {
    const h = makeHarness({ rows: [] });
    const state = await runChain(h);
    expect(h.llm).not.toHaveBeenCalled();
    expect(h.saved).toHaveLength(0);
    expect(state.summary).toMatch(/sem gasto|não teve/i);
    expect(h.closed[0]?.status).toBe("succeeded");
  });

  it("persiste os rótulos de conversão resolvidos (id→nome) p/ a config ler do banco", async () => {
    const entities: AdEntity[] = [
      { id: "c1", level: "campaign", name: "Campanha 1", status: "active", objective: { goal: "custom", customConversionId: "123", label: "Comprou Curso Premium" } },
    ];
    const h = makeHarness({ entities });
    await runChain(h);
    expect(h.savedLabels).toContainEqual({ goal: "custom", customConversionId: "123", label: "Comprou Curso Premium" });
  });

  it("cron: campanha sem mudança material HERDA a análise (não re-chama o LLM no mapa)", async () => {
    const last = new Map<string, LastEntityAnalysis>([
      ["c1", {
        unit: ANALYSIS_OUTPUT as unknown as LastEntityAnalysis["unit"],
        metrics: { spend: 300, cpa: 100, roas: 1, ctr: 5 },
        flags: ["cpa_acima_da_meta"],
        tier: null,
        curated: null,
        analyzedAt: new Date(), // recente → não dispara o deep por intervalo
      }],
    ]);
    const h = makeHarness({ last }); // sem configChangedAt
    await runChain(h, "cron");
    // c1 herda → o mapa (meta.type "unit") NÃO chama o LLM.
    expect(unitCalls(h.llm)).toBe(0);
  });

  it("cron: config mudou depois da última análise → força deep (re-analisa mesmo sem mudança de métrica)", async () => {
    const last = new Map<string, LastEntityAnalysis>([
      ["c1", {
        unit: ANALYSIS_OUTPUT as unknown as LastEntityAnalysis["unit"],
        metrics: { spend: 300, cpa: 100, roas: 1, ctr: 5 },
        flags: ["cpa_acima_da_meta"],
        tier: null,
        curated: null,
        analyzedAt: new Date(Date.now() - 60_000), // 1 min atrás
      }],
    ]);
    const h = makeHarness({ last, configChangedAt: new Date() }); // config mudou depois
    const repos = (h.deps as unknown as { _repos: { repo: AnalysisRepo } })._repos;
    await runChain(h, "cron");
    // deep forçado → c1 re-analisado no mapa (meta.type "unit") mesmo sem mudança de métrica.
    expect(unitCalls(h.llm)).toBe(1);
    // marcador consumido (one-shot) → próximo run volta ao incremental.
    expect(repos.repo.consumeConfigChanged).toHaveBeenCalledTimes(1);
  });

  describe("guardrail: releitura pontual do no-op (5b — cache stale)", () => {
    const PAUSED_C1: AdEntity[] = [
      { id: "c1", level: "campaign", name: "Campanha 1", status: "paused", objective: { goal: "purchase" } },
    ];

    it("cache diz pausada mas a Meta está ATIVA (drift) → releitura corrige e a ação NÃO é barrada", async () => {
      const h = makeHarness({ entities: PAUSED_C1, freshEntityState: { status: "ACTIVE", effective_status: "ACTIVE" } });
      const state = await runChain(h);
      expect(h.readEntityState).toHaveBeenCalledWith(expect.anything(), "c1");
      expect(state.droppedActions?.some((d) => d.action.target.id === "c1")).toBe(false);
      expect(state.approvalCandidates?.some((a) => a.target.id === "c1")).toBe(true);
    });

    it("cache diz pausada e a Meta CONFIRMA pausada → mantém barrada (no-op de verdade)", async () => {
      const h = makeHarness({ entities: PAUSED_C1, freshEntityState: { status: "PAUSED", effective_status: "PAUSED" } });
      const state = await runChain(h);
      expect(h.readEntityState).toHaveBeenCalledWith(expect.anything(), "c1");
      expect(state.droppedActions?.some((d) => d.action.target.id === "c1" && d.reason === "entidade já está neste estado")).toBe(true);
      expect(state.approvalCandidates?.some((a) => a.target.id === "c1")).toBe(false);
    });

    it("cache diz ATIVA mas a Meta já está pausada (no-op na direção OPOSTA) → releitura pega e barra", async () => {
      // cache = "active" (não bate com o alvo "paused" de pause_entity) — a versão antiga
      // (assimétrica) da releitura NUNCA checaria esta entidade, deixando passar uma
      // sugestão de "pausar" algo que já está pausado.
      const h = makeHarness({ freshEntityState: { status: "PAUSED", effective_status: "PAUSED" } });
      const state = await runChain(h);
      expect(h.readEntityState).toHaveBeenCalledWith(expect.anything(), "c1");
      expect(state.droppedActions?.some((d) => d.action.target.id === "c1" && d.reason === "entidade já está neste estado")).toBe(true);
      expect(state.approvalCandidates?.some((a) => a.target.id === "c1")).toBe(false);
    });

    it("sem candidata de status (só a entidade sem ação de status) → NÃO relê (custo zero)", async () => {
      // "c1" some do catálogo → o alvo da recomendação de pausar vira inválido (nenhuma
      // ação de status é gerada) — não há o que reler.
      const h = makeHarness({ entities: [{ id: "c2", level: "campaign", name: "Outra", status: "active", objective: { goal: "purchase" } }] });
      await runChain(h);
      expect(h.readEntityState).not.toHaveBeenCalled();
    });
  });

  it("token inválido no fetch → AnalysisError + marca token inválido", async () => {
    const h = makeHarness({ tokenInvalid: true });
    const repos = (h.deps as unknown as { _repos: { repo: AnalysisRepo; snapshots: InsightsSnapshotsRepo } })._repos;
    const n = makeAccountAnalysisNodes(h.deps, repos);
    const base = { runId: "r", orgId: "o", agentId: "a", adAccountId: "acc", trigger: "on_demand" } as unknown as AccountAnalysisStateType;
    const afterLoad = { ...base, ...(await n.loadContext(base)) } as AccountAnalysisStateType;
    await expect(n.fetchData(afterLoad)).rejects.toBeInstanceOf(AnalysisError);
    expect(repos.repo.markTokenInvalid).toHaveBeenCalled();
  });

  describe("proposeDrafts (P1.1 — refresh_fatigued vira recomendação-only)", () => {
    function stateWithCampaign(campaign: Record<string, unknown>): AccountAnalysisStateType {
      return {
        runId: "run-1",
        orgId: "org-1",
        agentId: "agent-1",
        adAccountId: "acc-uuid",
        notifyPolicy: { proactiveDrafts: { enabled: true } },
        brief: { account: { currency: "BRL" }, segments: { campaigns: [campaign] } },
      } as unknown as AccountAnalysisStateType;
    }

    it("campanha FATIGADA (sem vencedor) → só insere recommendation human_direction, sem draft/approval", async () => {
      const h = makeHarness();
      const repos = (h.deps as unknown as { _repos: Parameters<typeof makeAccountAnalysisNodes>[1] })._repos;
      const n = makeAccountAnalysisNodes(h.deps, repos);
      const state = stateWithCampaign({
        id: "c1",
        level: "campaign",
        name: "Campanha Fatigada",
        status: "active",
        eligibility: { hasSignificance: true },
        healthSignals: ["creative_fatigue"],
        metrics: { spend: 100 },
      });

      await n.proposeDrafts(state);

      expect(h.insertedRecommendations).toHaveLength(1);
      expect(h.insertedRecommendations[0]).toMatchObject({ kind: "human_direction", title: "Testar um ângulo novo" });
      expect(h.insertedRecommendations[0]?.["toolKey"]).toBeUndefined();
      expect(h.insertedRecommendations[0]?.["draftId"]).toBeUndefined();
    });

    it("vencedor claro (scale_winner) NÃO entra no ramo human_direction do P1.1", async () => {
      // mock de db/ads aqui é mínimo (não simula a saga inteira de proposeScaleWinner) — este
      // teste prova só o ROTEAMENTO: uma oportunidade `scale_winner` nunca cai no atalho
      // `human_direction` (exclusivo de `refresh_fatigued`). O caminho normal segue seu try/catch
      // próprio (best-effort), coberto por outros testes/roteiro manual.
      const h = makeHarness();
      const repos = (h.deps as unknown as { _repos: Parameters<typeof makeAccountAnalysisNodes>[1] })._repos;
      const n = makeAccountAnalysisNodes(h.deps, repos);
      const state = stateWithCampaign({
        id: "c1",
        level: "campaign",
        name: "Campanha Vencedora",
        status: "active",
        tier: "winner",
        eligibility: { hasSignificance: true },
        healthSignals: [],
        metrics: { spend: 100 },
      });

      await n.proposeDrafts(state);

      expect(h.insertedRecommendations).toHaveLength(0);
      // chegou a TENTAR escalar (entrou no try/catch best-effort) — distingue do próximo teste,
      // onde o sinal de budget barra a oportunidade ANTES de qualquer tentativa.
      const debug = (h.deps as unknown as { logger: { debug: ReturnType<typeof vi.fn> } }).logger.debug;
      expect(debug).toHaveBeenCalledWith(expect.anything(), "propose_drafts:pulado");
    });

    it("vencedor com FOLGA de budget (atBudgetCeiling=false) → replicate_winner (Fatia 8): tenta replicar pra público novo, não escala budget", async () => {
      // Slice 1 (Fatia 8): antes folga confirmada = nenhuma oportunidade; AGORA vira replicate_winner
      // (replicar a oferta provada pra um público novo). O nó entra na criação segmentada (proposeCopy);
      // com o harness mínimo isso degrada best-effort ("pulado") em vez de virar scale-raise.
      const h = makeHarness();
      const repos = (h.deps as unknown as { _repos: Parameters<typeof makeAccountAnalysisNodes>[1] })._repos;
      const n = makeAccountAnalysisNodes(h.deps, repos);
      const state = stateWithCampaign({
        id: "c1",
        level: "campaign",
        name: "Campanha com Folga",
        status: "active",
        tier: "winner",
        eligibility: { hasSignificance: true },
        healthSignals: [],
        metrics: { spend: 100 },
        atBudgetCeiling: false, // folga de orçamento confirmada → replicar, não subir budget
      });

      await n.proposeDrafts(state);

      // NÃO gerou a ação de subir orçamento (adjust_budget) — folga não escala budget.
      expect(h.insertedRecommendations.some((r) => r["toolKey"] === "adjust_budget")).toBe(false);
      // entrou na tentativa de criação segmentada (replicate) — degrada best-effort no harness mínimo.
      const debug = (h.deps as unknown as { logger: { debug: ReturnType<typeof vi.fn> } }).logger.debug;
      expect(debug).toHaveBeenCalledWith(expect.anything(), "propose_drafts:pulado");
    });
  });
});
