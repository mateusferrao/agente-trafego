import { describe, expect, it, vi } from "vitest";
import type { AdEntity, EncryptedPayload, InsightRow } from "@trafego/shared";
import type { WorkerDeps } from "../../composition.js";
import type { AnalysisRepo, RecommendationRow } from "../../modules/analysis/repo.js";
import type { InsightsSnapshotsRepo } from "../../modules/insights/repo.js";
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

const ANALYSIS_OUTPUT = {
  summary: "Conta gastou R$300; CPA acima da meta na Campanha 1.",
  findings: [{ id: "f1", title: "CPA alto", detail: "R$100/venda", severity: "warning", metricRefs: [] }],
  recommendations: [
    { id: "r1", title: "Pausar Campanha 1", rationale: "CPA 2x a meta", priority: "high", actionType: "pause", targetEntity: { level: "campaign", externalId: "c1" }, budgetChangePct: null },
    { id: "r2", title: "Revisar criativo", rationale: "Fadiga", priority: "medium", actionType: "review_creative", targetEntity: null, budgetChangePct: null },
    { id: "r3", title: "Pausar fantasma", rationale: "id inexistente", priority: "low", actionType: "pause", targetEntity: { level: "ad", externalId: "ZZZ" }, budgetChangePct: null },
  ],
};

interface Harness {
  deps: WorkerDeps;
  saved: RecommendationRow[];
  closed: { status: string; summary: string | null; costSnapshot: number | null }[];
  llm: ReturnType<typeof vi.fn>;
}

function makeHarness(opts: { rows?: InsightRow[]; tokenInvalid?: boolean } = {}): Harness {
  const saved: RecommendationRow[] = [];
  const closed: Harness["closed"] = [];
  const rows = opts.rows ?? [row("act_1", "account", 300, 5), row("c1", "campaign", 300, 3)];

  const repo: AnalysisRepo = {
    loadAgentContext: vi.fn(async () => ({ goals: { targetCPA: 50 }, archetype: "conservador", systemPrompt: null, playbook: [] })),
    loadAccount: vi.fn(async () => ({ metaAdAccountId: "act_1", name: "Conta", currency: "BRL", tokenCripto: TOKEN })),
    openRun: vi.fn(async () => {}),
    markTokenInvalid: vi.fn(async () => {}),
    saveRecommendations: vi.fn(async (r: readonly RecommendationRow[]) => { saved.push(...r); }),
    closeRun: vi.fn(async (_o, _r, input) => { closed.push({ status: input.status, summary: input.summary, costSnapshot: input.costSnapshot }); }),
  };
  const snapshots: InsightsSnapshotsRepo = {
    latestDate: vi.fn(async () => null),
    upsertMany: vi.fn(async () => {}),
    listWindow: vi.fn(async () => rows),
  };
  const llm = vi.fn(async () => ({ output: ANALYSIS_OUTPUT, usage: { inputTokens: 100, outputTokens: 20, costUsd: 0.001 } }));

  const deps = {
    db: {} as never,
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
    redis: {} as never,
    ports: {
      ads: { listEntities: vi.fn(async (_ref, level) => (level === "campaign" ? ENTITIES : [])) } as never,
      messaging: {} as never,
      llm: { completeStructured: llm, complete: vi.fn() } as never,
      vault: { decrypt: vi.fn(() => "tok"), encrypt: vi.fn() } as never,
      scheduler: {} as never,
      metering: {} as never,
      approval: {} as never,
    },
    insightsSync: { sync: vi.fn(async () => ({ partial: false, tokenInvalid: opts.tokenInvalid ?? false, snapshotsWritten: rows.length })) } as never,
    analysis: { model: "m", windowDays: 7, baselineDays: 7, topN: 5 },
    checkpointer: undefined,
  } as unknown as WorkerDeps;

  const nodesWithFakes = { repo, snapshots };
  // guarda os fakes p/ o teste montar os nós
  (deps as unknown as { _repos: typeof nodesWithFakes })._repos = nodesWithFakes;
  return { deps, saved, closed, llm };
}

/** Roda a cadeia read-only, mesclando os patches (simula o StateGraph). */
async function runChain(h: Harness): Promise<AccountAnalysisStateType> {
  const repos = (h.deps as unknown as { _repos: { repo: AnalysisRepo; snapshots: InsightsSnapshotsRepo } })._repos;
  const n = makeAccountAnalysisNodes(h.deps, repos);
  let state = {
    runId: "run-1",
    orgId: "org-1",
    agentId: "agent-1",
    adAccountId: "acc-uuid",
    trigger: "on_demand",
  } as unknown as AccountAnalysisStateType;
  const apply = (patch: AccountAnalysisUpdate) => { state = { ...state, ...patch } as AccountAnalysisStateType; };

  apply(await n.loadContext(state));
  apply(await n.fetchData(state));
  apply(await n.runPlaybook(state));
  apply(await n.llmAnalyze(state));
  apply(await n.buildRecommendations(state));
  apply(await n.record(state));
  return state;
}

describe("account-analysis read-only nodes", () => {
  it("happy path: analisa, mapeia recomendações e fecha o run", async () => {
    const h = makeHarness();
    await runChain(h);

    expect(h.llm).toHaveBeenCalledOnce();
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
    expect(h.closed[0]).toMatchObject({ status: "succeeded", costSnapshot: 0.001 });
  });

  it("conta parada: pula o LLM e conclui com nota 'sem atividade'", async () => {
    const h = makeHarness({ rows: [] });
    const state = await runChain(h);
    expect(h.llm).not.toHaveBeenCalled();
    expect(h.saved).toHaveLength(0);
    expect(state.summary).toMatch(/sem gasto|não teve/i);
    expect(h.closed[0]?.status).toBe("succeeded");
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
