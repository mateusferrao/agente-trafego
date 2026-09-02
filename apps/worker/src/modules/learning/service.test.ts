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
  maxNewLessonsPerTick: 20,
  decayStaleDays: 30,
  decayArchiveDays: 60,
  phaseBufferDays: 7,
  outcomeWindowDays: 7,
  accountMinEntities: 3,
  temporalLookbackDays: 60,
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
  refreshes: { id: string; confidence: number; supportCount: number; proposedThresholdPatch?: Record<string, unknown> }[];
}

type ExistingLesson = { id: string; confidence: number | null; lastReinforcedAt: Date | null; reinforceCount: number; confirmedByHuman: boolean; thresholdResolvedAt: Date | null };

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
    reinforceLesson: async (_orgId, _agentId, id, confidence, evidenceAt) => {
      state.reinforces.push({ id, confidence, evidenceAt });
    },
    loadEvidence: async () => evidence,
    refreshAccountPrior: async ({ id, confidence, supportCount, proposedThresholdPatch }) => {
      state.refreshes.push({ id, confidence, supportCount, ...(proposedThresholdPatch ? { proposedThresholdPatch } : {}) });
    },
    loadCampaignCtrSeries: async () => [],
    loadAccountConversionSeries: async () => [],
    applyDecaySweep: async () => ({ staled: 0, archived: 0 }),
    saveEntityConfigSnapshots: async () => {},
  };
}

describe("learning service — distillAgent", () => {
  it("cria lição nova com o texto DETERMINÍSTICO (na voz, sem travessão) + marca a evidência (dedup)", async () => {
    const state: FakeRepoState = { inserts: [], reinforces: [], refreshes: [] };
    const svc = createLearningService({ repo: fakeRepo(null, trackingRuns(), state), logger, config: CONFIG, outcomeRepo: emptyOutcomeRepo() });
    const r = await svc.distillAgent(AGENT, { remaining: 20 });
    expect(r.created).toBe(1);
    expect(r.reinforced).toBe(0);
    // texto = template determinístico do tracking (sem LLM), sóbrio e sem travessão dramático.
    expect(state.inserts[0]?.content).toContain("medição de conversão");
    expect(state.inserts[0]?.content).not.toContain("—");
    // evidência = run mais novo (dedup).
    expect(state.inserts[0]?.evidenceAt.toISOString()).toBe("2026-01-03T00:00:00.000Z");
    expect(state.inserts[0]?.sourceRunId).toBe("r3");
  });

  it("reforça quando há evidência MAIS NOVA que a última incorporada", async () => {
    const state: FakeRepoState = { inserts: [], reinforces: [], refreshes: [] };
    const existing = { id: "l1", confidence: 0.2, lastReinforcedAt: new Date("2026-01-02T00:00:00.000Z"), reinforceCount: 1, confirmedByHuman: false, thresholdResolvedAt: null };
    const svc = createLearningService({ repo: fakeRepo(existing, trackingRuns(), state), logger, config: CONFIG, outcomeRepo: emptyOutcomeRepo() });
    const r = await svc.distillAgent(AGENT, { remaining: 20 });
    expect(r.reinforced).toBe(1);
    expect(r.created).toBe(0);
    expect(state.reinforces[0]?.confidence).toBeGreaterThan(0.2);
  });

  it("NÃO reforça sobre a mesma janela já incorporada (dedup do cron diário)", async () => {
    const state: FakeRepoState = { inserts: [], reinforces: [], refreshes: [] };
    // já reforçamos até o run mais novo (r3) — um novo tick sobre a mesma janela é no-op.
    const existing = { id: "l1", confidence: 0.4, lastReinforcedAt: new Date("2026-01-03T00:00:00.000Z"), reinforceCount: 1, confirmedByHuman: false, thresholdResolvedAt: null };
    const svc = createLearningService({ repo: fakeRepo(existing, trackingRuns(), state), logger, config: CONFIG, outcomeRepo: emptyOutcomeRepo() });
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
      loadWindow: async (_org, _acc, entityId, from) => {
        if (entityId !== "c1") return { spend: 0, results: 0 };
        return from < "2026-02-01" ? { spend: 100, results: 10 } : { spend: 200, results: 10 };
      },
      commitOutcome: async (i) => { commits.push(i); },
    });
    const svc = createLearningService({
      repo: fakeRepo(null, [], state),
      outcomeRepo,
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
    const svc = createLearningService({ repo: fakeRepo(null, [], state), outcomeRepo, logger, config: CONFIG });
    const r = await svc.measureOutcomes(AGENT);
    expect(r.measured).toBe(0);
  });

  it("ADIA a criação quando o teto de criação esgotou (não grava lição sem orçamento)", async () => {
    const state: FakeRepoState = { inserts: [], reinforces: [], refreshes: [] };
    const svc = createLearningService({ repo: fakeRepo(null, trackingRuns(), state), logger, config: CONFIG, outcomeRepo: emptyOutcomeRepo() });
    const r = await svc.distillAgent(AGENT, { remaining: 0 });
    expect(r.created).toBe(0); // adiado — vira candidata no próximo tick com orçamento
    expect(state.inserts).toHaveLength(0);
  });
});

describe("learning service — distillAccount (prior de conta do ledger)", () => {
  /** ledger com N entidades DISTINTAS sustentando o mesmo par (dimensão,direção). */
  function evidence(pattern: "cut" | "scaleBad" | "scaleGood", entityIds: string[]): AccountEvidenceRow[] {
    const key =
      pattern === "cut"
        ? { dimension: "budget" as const, direction: "lower" as const }
        : pattern === "scaleBad"
          ? { dimension: "pacing" as const, direction: "lower" as const }
          : { dimension: "pacing" as const, direction: "raise" as const };
    return entityIds.map((entityId) => ({ ...key, entityId, supports: true }));
  }

  it("materializa 1 prior de conta quando >= K (3) entidades distintas sustentam", async () => {
    const state: FakeRepoState = { inserts: [], reinforces: [], refreshes: [] };
    const svc = createLearningService({
      repo: fakeRepo(null, [], state, evidence("cut", ["c1", "c2", "c3"])),
      logger,
      config: CONFIG,
      outcomeRepo: emptyOutcomeRepo(),
    });
    const r = await svc.distillAccount(AGENT, { remaining: 20 });
    expect(r.created).toBe(1);
    expect(state.inserts[0]?.candidate.key).toMatchObject({ scope: "account", dimension: "budget", direction: "lower" });
    // texto determinístico (template account_cut_pays, na voz) — 3 entidades distintas.
    expect(state.inserts[0]?.content).toBe("Cortar desperdício cedo tem valido a pena aqui. Vi isso em 3 campanhas.");
  });

  it("NÃO nasce prior com < K entidades distintas (nem repetindo a mesma)", async () => {
    const state: FakeRepoState = { inserts: [], reinforces: [], refreshes: [] };
    // 2 distintas + 1 repetida de c1 → só 2 distintas → abaixo de K.
    const svc = createLearningService({
      repo: fakeRepo(null, [], state, evidence("cut", ["c1", "c2", "c1"])),
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
      { id: "l1", confidence: 0.7, lastReinforcedAt: new Date("2026-01-01T00:00:00.000Z"), reinforceCount: 3, confirmedByHuman: false, thresholdResolvedAt: null },
      [],
      { inserts: [], reinforces: [], refreshes: [] } as FakeRepoState,
      evidence("cut", ["c1", "c2", "c3", "c4"]),
    );
    const state: FakeRepoState = { inserts: [], reinforces: [], refreshes: [] };
    // reusa o mesmo ledger/existing via um repo dedicado (o state acima é descartado).
    const repo = { ...grown, refreshAccountPrior: async ({ id, confidence, supportCount }: { id: string; confidence: number; supportCount: number }) => { state.refreshes.push({ id, confidence, supportCount }); } };
    const svc = createLearningService({ repo: repo as never, logger, config: CONFIG, outcomeRepo: emptyOutcomeRepo() });
    const r = await svc.distillAccount(AGENT, { remaining: 20 });
    expect(r.reinforced).toBe(1);
    expect(state.refreshes[0]?.supportCount).toBe(4);
  });

  it("prior FORTE (>= 5 entidades, direção lower) nasce com proposta de limiar (opt-in)", async () => {
    const state: FakeRepoState = { inserts: [], reinforces: [], refreshes: [] };
    const svc = createLearningService({
      repo: fakeRepo(null, [], state, evidence("cut", ["c1", "c2", "c3", "c4", "c5"])),
      logger,
      config: CONFIG,
      outcomeRepo: emptyOutcomeRepo(),
    });
    const r = await svc.distillAccount(AGENT, { remaining: 20 });
    expect(r.created).toBe(1);
    // conservador: budget/lower → propõe apertar zombieMinSpend (cortar desperdício mais cedo).
    expect(state.inserts[0]?.proposedThresholdPatch).toMatchObject({ threshold: "zombieMinSpend" });
  });

  it("dispara alerta (onNewLearning) quando um prior de conta NOVO nasce", async () => {
    const state: FakeRepoState = { inserts: [], reinforces: [], refreshes: [] };
    const alerts: { kind: string; content: string }[] = [];
    const svc = createLearningService({
      repo: fakeRepo(null, [], state, evidence("cut", ["c1", "c2", "c3"])),
      logger,
      config: CONFIG,
      outcomeRepo: emptyOutcomeRepo(),
      onNewLearning: async (_agent, e) => { alerts.push(e); },
    });
    await svc.distillAccount(AGENT, { remaining: 20 });
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.kind).toBe("prior");
    expect(alerts[0]?.content).toBe("Cortar desperdício cedo tem valido a pena aqui. Vi isso em 3 campanhas.");
  });

  it("prior AGRESSIVO (escala compensa, direção raise) NUNCA nasce com proposta", async () => {
    const state: FakeRepoState = { inserts: [], reinforces: [], refreshes: [] };
    const svc = createLearningService({
      repo: fakeRepo(null, [], state, evidence("scaleGood", ["c1", "c2", "c3", "c4", "c5"])),
      logger,
      config: CONFIG,
      outcomeRepo: emptyOutcomeRepo(),
    });
    const r = await svc.distillAccount(AGENT, { remaining: 20 });
    expect(r.created).toBe(1);
    expect(state.inserts[0]?.candidate.key).toMatchObject({ dimension: "pacing", direction: "raise" });
    expect(state.inserts[0]?.proposedThresholdPatch).toBeUndefined();
  });

  it("prior forte já resolvido (rejeitado/revertido) NÃO re-anexa proposta no refresh", async () => {
    const state: FakeRepoState = { inserts: [], reinforces: [], refreshes: [] };
    const svc = createLearningService({
      repo: fakeRepo(
        { id: "l1", confidence: 0.82, lastReinforcedAt: new Date("2026-01-01T00:00:00.000Z"), reinforceCount: 5, confirmedByHuman: false, thresholdResolvedAt: new Date("2026-01-05T00:00:00.000Z") },
        [],
        state,
        evidence("cut", ["c1", "c2", "c3", "c4", "c5", "c6"]),
      ),
      logger,
      config: CONFIG,
      outcomeRepo: emptyOutcomeRepo(),
    });
    const r = await svc.distillAccount(AGENT, { remaining: 20 });
    expect(r.reinforced).toBe(1); // suporte cresceu 5→6 → atualiza confiança
    expect(state.refreshes[0]?.proposedThresholdPatch).toBeUndefined(); // mas sem re-oferta
  });

  it("prior já existente e suporte IGUAL → no-op (não reescreve)", async () => {
    const state: FakeRepoState = { inserts: [], reinforces: [], refreshes: [] };
    const svc = createLearningService({
      repo: fakeRepo(
        { id: "l1", confidence: 0.7, lastReinforcedAt: new Date("2026-01-01T00:00:00.000Z"), reinforceCount: 3, confirmedByHuman: false, thresholdResolvedAt: null },
        [],
        state,
        evidence("cut", ["c1", "c2", "c3"]),
      ),
      logger,
      config: CONFIG,
      outcomeRepo: emptyOutcomeRepo(),
    });
    const r = await svc.distillAccount(AGENT, { remaining: 20 });
    expect(r.reinforced).toBe(0);
    expect(state.refreshes).toHaveLength(0);
  });
});

describe("learning service — distillTemporal (padrões temporais, Classe B)", () => {
  function fatiguingCtr(fatigueDay: number, length = 12): number[] {
    return Array.from({ length }, (_, day) => (day < fatigueDay ? 5 : 1));
  }

  it("materializa o prior de timing de fadiga quando o padrão é apertado em >= K campanhas", async () => {
    const state: FakeRepoState = { inserts: [], reinforces: [], refreshes: [] };
    const base = fakeRepo(null, [], state);
    const repo = {
      ...base,
      loadCampaignCtrSeries: async () => [
        { campaignId: "c1", ctrByDay: fatiguingCtr(6) },
        { campaignId: "c2", ctrByDay: fatiguingCtr(6) },
        { campaignId: "c3", ctrByDay: fatiguingCtr(7) },
      ],
      loadAccountConversionSeries: async () => [],
    };
    const svc = createLearningService({ repo: repo as never, logger, config: CONFIG, outcomeRepo: emptyOutcomeRepo() });
    const r = await svc.distillTemporal(AGENT, { remaining: 20 });
    expect(r.created).toBe(1);
    expect(state.inserts[0]?.candidate.key).toMatchObject({ scope: "account", dimension: "creative", direction: "neutral" });
    expect(state.inserts[0]?.candidate.evidence.pattern).toBe("account_fatigue_timing");
  });

  it("sem série suficiente → nenhum prior temporal (empty state honesto)", async () => {
    const state: FakeRepoState = { inserts: [], reinforces: [], refreshes: [] };
    const svc = createLearningService({ repo: fakeRepo(null, [], state), logger, config: CONFIG, outcomeRepo: emptyOutcomeRepo() });
    const r = await svc.distillTemporal(AGENT, { remaining: 20 });
    expect(r.created).toBe(0);
    expect(state.inserts).toHaveLength(0);
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
      loadWindow: async (_org, _acc, _entityId, from) => (from < "2026-02-01" ? { spend: 100, results: 10 } : { spend: 40, results: 10 }),
      insertEvidence: async (rows) => { evidenceRows.push(...rows); },
    });
    const svc = createLearningService({ repo: fakeRepo(null, [], state), outcomeRepo, logger, config: CONFIG, now: () => new Date("2026-03-01T00:00:00.000Z") });
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
    const svc = createLearningService({ repo: fakeRepo(null, [], state), outcomeRepo, logger, config: CONFIG, now: () => new Date("2026-03-01T00:00:00.000Z") });
    const r = await svc.measureManualChanges(AGENT);
    expect(r.evidence).toBe(0);
    expect(evidenceRows).toHaveLength(0);
  });
});
