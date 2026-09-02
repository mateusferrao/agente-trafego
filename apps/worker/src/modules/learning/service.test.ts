import { describe, expect, it, vi } from "vitest";
import type { Logger } from "pino";
import type { AccountEvidenceRow, RunLearningSnapshot } from "@trafego/core";
import { createLearningService, type LearningServiceConfig } from "./service.js";
import type { InsertLessonInput, LearnableAgent, LearningRepo } from "./repo.js";
import type { CommitOutcomeInput, MeasurableRec, OutcomeRepo } from "./outcome-repo.js";

const AGENT: LearnableAgent = { orgId: "org-1", agentId: "agent-1", adAccountId: "acc-1" };
const CONFIG: LearningServiceConfig = {
  historyRuns: 10,
  minRuns: 3,
  minOccurrenceRatio: 0.6,
  redactorModel: "m",
  redactorMaxPerTick: 20,
  decayStaleDays: 30,
  decayArchiveDays: 60,
  phaseBufferDays: 7,
  outcomeWindowDays: 7,
  accountMinEntities: 3,
};

/** OutcomeRepo stub: sem recs medíveis por padrão (destilação observacional isolada). */
function emptyOutcomeRepo(over: Partial<OutcomeRepo> = {}): OutcomeRepo {
  return {
    loadMeasurableRecs: async () => [],
    loadMaturedConfigChanges: async () => [],
    hasAppliedActionInRange: async () => false,
    findAppliedInstant: async () => null,
    loadWindow: async () => ({ spend: 0, results: 0 }),
    commitOutcome: async () => {},
    insertEvidence: async () => {},
    ...over,
  };
}

const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger;

/** 3 runs com tracking suspeito recorrente → 1 candidata fact/tracking/account (v3: o
 *  observacional por-entidade foi removido; o único fact observacional é o de conta). */
function trackingRuns(): RunLearningSnapshot[] {
  return [
    { runId: "r1", at: "2026-01-01T00:00:00.000Z", campaigns: [], trackingSuspect: true },
    { runId: "r2", at: "2026-01-02T00:00:00.000Z", campaigns: [], trackingSuspect: true },
    { runId: "r3", at: "2026-01-03T00:00:00.000Z", campaigns: [], trackingSuspect: true },
  ];
}

interface FakeRepoState {
  inserts: InsertLessonInput[];
  reinforces: { id: string; confidence: number; evidenceAt: Date }[];
  refreshes: { id: string; confidence: number; supportCount: number }[];
}

type ExistingLesson = { id: string; confidence: number | null; lastReinforcedAt: Date | null; reinforceCount: number };

function fakeRepo(
  existing: ExistingLesson | null,
  runs: RunLearningSnapshot[],
  state: FakeRepoState,
  evidence: AccountEvidenceRow[] = [],
): LearningRepo {
  return {
    listLearnableAgents: async () => [AGENT],
    loadRunHistory: async () => runs,
    loadActiveLessons: async () => [],
    findLessonByKey: async () => existing,
    insertLesson: async (i) => {
      state.inserts.push(i);
    },
    reinforceLesson: async (id, confidence, evidenceAt) => {
      state.reinforces.push({ id, confidence, evidenceAt });
    },
    loadEvidence: async () => evidence,
    refreshAccountPrior: async (id, confidence, supportCount) => {
      state.refreshes.push({ id, confidence, supportCount });
    },
    applyDecaySweep: async () => ({ staled: 0, archived: 0 }),
    saveEntityConfigSnapshots: async () => {},
  };
}

function llmStub(text: string | Error) {
  return {
    complete: vi.fn(async () => {
      if (text instanceof Error) throw text;
      return { output: text, usage: { inputTokens: 1, outputTokens: 1 } };
    }),
    completeStructured: vi.fn(),
  };
}

describe("learning service — distillAgent", () => {
  it("cria lição nova com o texto do redator + marca a evidência (dedup) na criação", async () => {
    const state: FakeRepoState = { inserts: [], reinforces: [], refreshes: [] };
    const llm = llmStub("Frase do redator.");
    const svc = createLearningService({ repo: fakeRepo(null, trackingRuns(), state), llm: llm as never, logger, config: CONFIG, outcomeRepo: emptyOutcomeRepo() });
    const r = await svc.distillAgent(AGENT, { remaining: 20 });
    expect(r.created).toBe(1);
    expect(r.reinforced).toBe(0);
    expect(state.inserts[0]?.content).toBe("Frase do redator.");
    // evidência = run mais novo (dedup).
    expect(state.inserts[0]?.evidenceAt.toISOString()).toBe("2026-01-03T00:00:00.000Z");
    expect(state.inserts[0]?.sourceRunId).toBe("r3");
  });

  it("cai no fallback determinístico quando o redator LLM falha (loop funciona sem LLM)", async () => {
    const state: FakeRepoState = { inserts: [], reinforces: [], refreshes: [] };
    const llm = llmStub(new Error("llm down"));
    const svc = createLearningService({ repo: fakeRepo(null, trackingRuns(), state), llm: llm as never, logger, config: CONFIG, outcomeRepo: emptyOutcomeRepo() });
    await svc.distillAgent(AGENT, { remaining: 20 });
    expect(state.inserts[0]?.content).toContain("medição");
  });

  it("reforça quando há evidência MAIS NOVA que a última incorporada", async () => {
    const state: FakeRepoState = { inserts: [], reinforces: [], refreshes: [] };
    const existing = { id: "l1", confidence: 0.2, lastReinforcedAt: new Date("2026-01-02T00:00:00.000Z"), reinforceCount: 1 };
    const svc = createLearningService({ repo: fakeRepo(existing, trackingRuns(), state), llm: llmStub("x") as never, logger, config: CONFIG, outcomeRepo: emptyOutcomeRepo() });
    const r = await svc.distillAgent(AGENT, { remaining: 20 });
    expect(r.reinforced).toBe(1);
    expect(r.created).toBe(0);
    expect(state.reinforces[0]?.confidence).toBeGreaterThan(0.2);
  });

  it("NÃO reforça sobre a mesma janela já incorporada (dedup do cron diário)", async () => {
    const state: FakeRepoState = { inserts: [], reinforces: [], refreshes: [] };
    // já reforçamos até o run mais novo (r3) — um novo tick sobre a mesma janela é no-op.
    const existing = { id: "l1", confidence: 0.4, lastReinforcedAt: new Date("2026-01-03T00:00:00.000Z"), reinforceCount: 1 };
    const svc = createLearningService({ repo: fakeRepo(existing, trackingRuns(), state), llm: llmStub("x") as never, logger, config: CONFIG, outcomeRepo: emptyOutcomeRepo() });
    const r = await svc.distillAgent(AGENT, { remaining: 20 });
    expect(r.reinforced).toBe(0);
    expect(r.created).toBe(0);
    expect(state.reinforces).toHaveLength(0);
  });

  it("mede outcome de ação aplicada → grava feedback + evidência no ledger (escala que deu errado)", async () => {
    const state: FakeRepoState = { inserts: [], reinforces: [], refreshes: [] };
    const commits: CommitOutcomeInput[] = [];
    const rec: MeasurableRec = {
      recId: "rec-1",
      runId: "run-1",
      adAccountId: "acc-1",
      actionType: "adjust_budget",
      params: { mode: "increase" },
      entityId: "c1",
      entityLevel: "campaign",
    };
    const outcomeRepo = emptyOutcomeRepo({
      loadMeasurableRecs: async () => [rec],
      findAppliedInstant: async () => new Date("2026-02-01T12:00:00.000Z"),
      // pré CPA 10 (100/10), pós CPA 20 (200/10) → piorou → negative → escala deu errado.
      loadWindow: async (_acc, entityId, from) => {
        if (entityId !== "c1") return { spend: 0, results: 0 };
        return from < "2026-02-01" ? { spend: 100, results: 10 } : { spend: 200, results: 10 };
      },
      commitOutcome: async (i) => { commits.push(i); },
    });
    const svc = createLearningService({
      repo: fakeRepo(null, [], state),
      outcomeRepo,
      llm: llmStub("x") as never,
      logger,
      config: CONFIG,
      now: () => new Date("2026-03-01T00:00:00.000Z"),
    });
    const r = await svc.measureOutcomes(AGENT);
    expect(r.measured).toBe(1);
    expect(commits[0]?.outcome).toBe("negative");
    // escala negativa → sustenta "escalar piora" (pacing/lower) e contradiz "escalar compensa".
    const ev = commits[0]?.evidence ?? [];
    expect(ev).toContainEqual(expect.objectContaining({ dimension: "pacing", direction: "lower", entityId: "c1", supports: true, outcome: "negative", source: "our_action" }));
    expect(ev).toContainEqual(expect.objectContaining({ dimension: "pacing", direction: "raise", entityId: "c1", supports: false }));
    // dedupeRef inclui (dimensão,direção) → o par não colide entre si.
    expect(new Set(ev.map((e) => e.dedupeRef)).size).toBe(ev.length);
  });

  it("recomendação NÃO aplicada por nós → não mede (sem Sinal A)", async () => {
    const state: FakeRepoState = { inserts: [], reinforces: [], refreshes: [] };
    const outcomeRepo = emptyOutcomeRepo({
      loadMeasurableRecs: async () => [{ recId: "rec-1", runId: "run-1", adAccountId: "acc-1", actionType: "pause_entity", params: {}, entityId: "c1", entityLevel: "campaign" }],
      findAppliedInstant: async () => null, // nunca aplicada
      commitOutcome: async () => { throw new Error("não deveria commitar"); },
    });
    const svc = createLearningService({ repo: fakeRepo(null, [], state), outcomeRepo, llm: llmStub("x") as never, logger, config: CONFIG });
    const r = await svc.measureOutcomes(AGENT);
    expect(r.measured).toBe(0);
  });

  it("ADIA a criação quando o teto do redator esgotou (não grava texto genérico permanente)", async () => {
    const state: FakeRepoState = { inserts: [], reinforces: [], refreshes: [] };
    const llm = llmStub("nunca usado");
    const svc = createLearningService({ repo: fakeRepo(null, trackingRuns(), state), llm: llm as never, logger, config: CONFIG, outcomeRepo: emptyOutcomeRepo() });
    const r = await svc.distillAgent(AGENT, { remaining: 0 });
    expect(llm.complete).not.toHaveBeenCalled();
    expect(r.created).toBe(0); // adiado — vira candidata no próximo tick com orçamento
    expect(state.inserts).toHaveLength(0);
  });

  it("passa runId (run mais novo) ao redator p/ o metering atribuir à conta", async () => {
    const state: FakeRepoState = { inserts: [], reinforces: [], refreshes: [] };
    const llm = llmStub("Frase.");
    const svc = createLearningService({ repo: fakeRepo(null, trackingRuns(), state), llm: llm as never, logger, config: CONFIG, outcomeRepo: emptyOutcomeRepo() });
    await svc.distillAgent(AGENT, { remaining: 20 });
    expect(llm.complete).toHaveBeenCalledWith(
      expect.objectContaining({ meta: expect.objectContaining({ orgId: "org-1", type: "learning", runId: "r3" }) }),
    );
  });
});

describe("learning service — distillAccount (prior de conta do ledger)", () => {
  /** ledger com N entidades DISTINTAS sustentando o mesmo par (dimensão,direção). */
  function evidence(pattern: "cut" | "scaleBad", entityIds: string[]): AccountEvidenceRow[] {
    return entityIds.map((entityId) =>
      pattern === "cut"
        ? { dimension: "budget", direction: "lower", entityId, supports: true }
        : { dimension: "pacing", direction: "lower", entityId, supports: true },
    );
  }

  it("materializa 1 prior de conta quando >= K (3) entidades distintas sustentam", async () => {
    const state: FakeRepoState = { inserts: [], reinforces: [], refreshes: [] };
    const svc = createLearningService({
      repo: fakeRepo(null, [], state, evidence("cut", ["c1", "c2", "c3"])),
      llm: llmStub("Cortar cedo compensa nesta conta.") as never,
      logger,
      config: CONFIG,
      outcomeRepo: emptyOutcomeRepo(),
    });
    const r = await svc.distillAccount(AGENT, { remaining: 20 });
    expect(r.created).toBe(1);
    expect(state.inserts[0]?.candidate.key).toMatchObject({ scope: "account", dimension: "budget", direction: "lower" });
    expect(state.inserts[0]?.content).toBe("Cortar cedo compensa nesta conta.");
  });

  it("NÃO nasce prior com < K entidades distintas (nem repetindo a mesma)", async () => {
    const state: FakeRepoState = { inserts: [], reinforces: [], refreshes: [] };
    // 2 distintas + 1 repetida de c1 → só 2 distintas → abaixo de K.
    const svc = createLearningService({
      repo: fakeRepo(null, [], state, evidence("cut", ["c1", "c2", "c1"])),
      llm: llmStub("x") as never,
      logger,
      config: CONFIG,
      outcomeRepo: emptyOutcomeRepo(),
    });
    const r = await svc.distillAccount(AGENT, { remaining: 20 });
    expect(r.created).toBe(0);
    expect(state.inserts).toHaveLength(0);
  });

  it("prior já existente: só atualiza quando o suporte CRESCEU (dedup do tick diário)", async () => {
    // já materializado com suporte 3; ledger agora tem 4 distintas → refresh com S=4.
    const grown = fakeRepo(
      { id: "l1", confidence: 0.7, lastReinforcedAt: new Date("2026-01-01T00:00:00.000Z"), reinforceCount: 3 },
      [],
      { inserts: [], reinforces: [], refreshes: [] } as FakeRepoState,
      evidence("cut", ["c1", "c2", "c3", "c4"]),
    );
    const state: FakeRepoState = { inserts: [], reinforces: [], refreshes: [] };
    // reusa o mesmo ledger/existing via um repo dedicado (o state acima é descartado).
    const repo = { ...grown, refreshAccountPrior: async (id: string, confidence: number, supportCount: number) => { state.refreshes.push({ id, confidence, supportCount }); } };
    const svc = createLearningService({ repo: repo as never, llm: llmStub("x") as never, logger, config: CONFIG, outcomeRepo: emptyOutcomeRepo() });
    const r = await svc.distillAccount(AGENT, { remaining: 20 });
    expect(r.reinforced).toBe(1);
    expect(state.refreshes[0]?.supportCount).toBe(4);
  });

  it("prior já existente e suporte IGUAL → no-op (não reescreve)", async () => {
    const state: FakeRepoState = { inserts: [], reinforces: [], refreshes: [] };
    const svc = createLearningService({
      repo: fakeRepo(
        { id: "l1", confidence: 0.7, lastReinforcedAt: new Date("2026-01-01T00:00:00.000Z"), reinforceCount: 3 },
        [],
        state,
        evidence("cut", ["c1", "c2", "c3"]),
      ),
      llm: llmStub("x") as never,
      logger,
      config: CONFIG,
      outcomeRepo: emptyOutcomeRepo(),
    });
    const r = await svc.distillAccount(AGENT, { remaining: 20 });
    expect(r.reinforced).toBe(0);
    expect(state.refreshes).toHaveLength(0);
  });
});

describe("learning service — measureManualChanges (mudança do gestor → ledger)", () => {
  it("mede a mudança manual madura e grava evidência (sem recommendation_feedback)", async () => {
    const state: FakeRepoState = { inserts: [], reinforces: [], refreshes: [] };
    const evidenceRows: unknown[] = [];
    const outcomeRepo = emptyOutcomeRepo({
      loadMaturedConfigChanges: async () => [
        { entityId: "c1", entityLevel: "campaign", changeDate: "2026-02-01", prev: { status: "active", dailyBudgetMinor: 1000 }, curr: { status: "paused" } },
      ],
      hasAppliedActionInRange: async () => false, // foi do gestor, não nossa
      // corte que deu certo: pré CPA 10, pós melhor (menos gasto, mesmos resultados).
      loadWindow: async (_acc, _entityId, from) => (from < "2026-02-01" ? { spend: 100, results: 10 } : { spend: 40, results: 10 }),
      insertEvidence: async (rows) => { evidenceRows.push(...rows); },
    });
    const svc = createLearningService({ repo: fakeRepo(null, [], state), outcomeRepo, llm: llmStub("x") as never, logger, config: CONFIG, now: () => new Date("2026-03-01T00:00:00.000Z") });
    const r = await svc.measureManualChanges(AGENT);
    expect(r.evidence).toBeGreaterThan(0);
    expect(evidenceRows[0]).toMatchObject({ dimension: "budget", direction: "lower", entityId: "c1", source: "human_manual" });
  });

  it("mudança que foi NOSSA (não do gestor) não vira evidência manual", async () => {
    const state: FakeRepoState = { inserts: [], reinforces: [], refreshes: [] };
    const evidenceRows: unknown[] = [];
    const outcomeRepo = emptyOutcomeRepo({
      loadMaturedConfigChanges: async () => [
        { entityId: "c1", entityLevel: "campaign", changeDate: "2026-02-01", prev: { status: "active", dailyBudgetMinor: 1000 }, curr: { status: "paused" } },
      ],
      hasAppliedActionInRange: async () => true, // ação NOSSA na janela → exclui
      insertEvidence: async (rows) => { evidenceRows.push(...rows); },
    });
    const svc = createLearningService({ repo: fakeRepo(null, [], state), outcomeRepo, llm: llmStub("x") as never, logger, config: CONFIG, now: () => new Date("2026-03-01T00:00:00.000Z") });
    const r = await svc.measureManualChanges(AGENT);
    expect(r.evidence).toBe(0);
    expect(evidenceRows).toHaveLength(0);
  });
});
