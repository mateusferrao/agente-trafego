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
  findings: [{ id: "f1", title: "CPA alto", detail: "R$100/venda", severity: "warning", metricRefs: [{ label: "CPA", value: 100 }] }],
  recommendations: [
    { id: "r1", title: "Pausar Campanha 1", rationale: "CPA 2x a meta", priority: "high", actionType: "pause", targetEntity: { level: "campaign", externalId: "c1" }, budgetChangePct: null },
    { id: "r2", title: "Revisar criativo", rationale: "Fadiga", priority: "medium", actionType: "review_creative", targetEntity: null, budgetChangePct: null },
    { id: "r3", title: "Pausar fantasma", rationale: "id inexistente", priority: "low", actionType: "pause", targetEntity: { level: "ad", externalId: "ZZZ" }, budgetChangePct: null },
  ],
};

interface Harness {
  deps: WorkerDeps;
  saved: RecommendationRow[];
  savedLabels: ConversionLabelRow[];
  closed: { status: string; summary: string | null; costSnapshot: number | null }[];
  llm: ReturnType<typeof vi.fn>;
  readEntityState: ReturnType<typeof vi.fn>;
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
}

function makeHarness(opts: HarnessOpts = {}): Harness {
  const saved: RecommendationRow[] = [];
  const savedLabels: ConversionLabelRow[] = [];
  const closed: Harness["closed"] = [];
  const rows = opts.rows ?? [row("act_1", "account", 300, 5), row("c1", "campaign", 300, 3)];
  const entities = opts.entities ?? ENTITIES;
  const byLevel = (level: string) => entities.filter((e) => e.level === level);

  const repo: AnalysisRepo = {
    loadAgentContext: vi.fn(async () => ({ goals: opts.goals ?? { targetCPA: 50 }, archetype: "conservador", systemPrompt: null, persona: null, tone: null, businessContext: null, guidance: null, configChangedAt: opts.configChangedAt ?? null, modelConfig: {}, autonomyPolicy: opts.autonomy ?? { bySource: { playbook: "suggest" as const, llm: "suggest" as const } }, guardrailConfig: opts.guardrail ?? { maxBudgetChangePct: 20, maxEntitiesPerDay: 3, allowedActions: ["pause_entity" as const], dryRun: true, killSwitch: false }, playbook: [], rejectedMemory: [], mutedCampaignIds: [] })),
    loadAccount: vi.fn(async () => ({ metaAdAccountId: "act_1", name: "Conta", currency: "BRL", tokenCripto: TOKEN })),
    openRun: vi.fn(async () => {}),
    markTokenInvalid: vi.fn(async () => {}),
    saveRecommendations: vi.fn(async (r: readonly RecommendationRow[]) => { saved.push(...r); }),
    saveConversionLabels: vi.fn(async (_o, _a, _p, labels: readonly ConversionLabelRow[]) => { savedLabels.push(...labels); }),
    consumeConfigChanged: vi.fn(async () => {}),
    loadDailyToolContext: vi.fn(async () => ({ touchedToday: new Set<string>(), budgetChangedToday: new Set<string>() })),
    recordStep: vi.fn(async () => {}),
    closeRun: vi.fn(async (_o, _r, input) => { closed.push({ status: input.status, summary: input.summary, costSnapshot: input.costSnapshot }); }),
  };
  const snapshots: InsightsSnapshotsRepo = {
    latestDate: vi.fn(async () => null),
    upsertMany: vi.fn(async () => {}),
    listWindow: vi.fn(async () => rows),
    latestSyncedAtByAccounts: vi.fn(async () => new Map()),
  };
  const entityAnalyses: EntityAnalysesRepo = {
    loadByAgent: vi.fn(async () => opts.last ?? new Map<string, LastEntityAnalysis>()),
    saveMany: vi.fn(async () => {}),
  };
  // no cron o chain chega ao notify (usa db real) — fake short-circuita o envio.
  const notify: NotifyRepo = {
    alreadyNotified: vi.fn(async () => true),
    loadTarget: vi.fn(async () => null),
    resolveInboundContact: vi.fn(async () => null),
    alreadyProcessed: vi.fn(async () => false),
    ensureConversation: vi.fn(async () => "conv-1"),
    recordMessage: vi.fn(async () => {}),
    resolveOutboundTarget: vi.fn(async () => null),
    updateInstanceStatus: vi.fn(async () => {}),
  };
  const llm = vi.fn(async () => ({ output: ANALYSIS_OUTPUT, usage: { inputTokens: 100, outputTokens: 20, costUsd: 0.001 } }));
  const readEntityState = vi.fn(async () => opts.freshEntityState ?? { status: "ACTIVE", effective_status: "ACTIVE" });

  const deps = {
    db: {} as never,
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
    redis: {} as never,
    ports: {
      ads: {
        listEntities: vi.fn(async (_ref, level) => byLevel(level)),
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
    analysis: {
      model: "m",
      unitModel: "m",
      messageModel: "m",
      visionModel: "m",
      windowDays: 7,
      baselineDays: 7,
      topN: 5,
      reviewEnabled: true,
      maxOutputTokens: 4000,
      reasoningEffort: "medium",
      maxCreativesVision: 8,
      notableAdsPerCampaign: 5,
      maxCreativesVisionPerCampaign: 3,
      mapConcurrency: 4,
      executionPolicy: "deep_periodic_incremental",
      deepIntervalDays: 7,
      materialChangePct: 15,
    },
    webOrigin: "https://app.example.com",
    checkpointer: undefined as never, // grafo A é linear (sem checkpointer)
  } as unknown as WorkerDeps;

  const nodesWithFakes = { repo, snapshots, entityAnalyses, notify, ...(opts.executor ? { executor: opts.executor } : {}) };
  // guarda os fakes p/ o teste montar os nós
  (deps as unknown as { _repos: typeof nodesWithFakes })._repos = nodesWithFakes;
  return { deps, saved, savedLabels, closed, llm, readEntityState };
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

    // 1 mapa (campanha c1 ativa) + síntese + revisor → 3 chamadas de LLM
    expect(h.llm).toHaveBeenCalledTimes(3);
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
    // usage somado nas 3 chamadas (mapa + síntese + revisor)
    expect(h.closed[0]).toMatchObject({ status: "succeeded", costSnapshot: 0.003 });
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

    // 1 mapa (campanha c1) + 1 síntese + 1 revisor = 3 chamadas de LLM
    expect(h.llm).toHaveBeenCalledTimes(3);
    // a análise por-campanha reanalisada é persistida (base do incremental), chaveada por id de campanha
    expect(repos.entityAnalyses.saveMany).toHaveBeenCalledTimes(1);
    const savedUnits = (repos.entityAnalyses.saveMany as ReturnType<typeof vi.fn>).mock.calls[0]?.[2] as { entityId: string }[];
    expect(savedUnits).toHaveLength(1);
    expect(savedUnits[0]?.entityId).toBe("c1");
    // recomendações da síntese persistidas
    expect(h.saved.length).toBeGreaterThan(0);
    expect(h.closed[0]?.status).toBe("succeeded");
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
});
