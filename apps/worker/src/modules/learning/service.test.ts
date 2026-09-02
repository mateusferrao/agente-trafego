import { describe, expect, it, vi } from "vitest";
import type { Logger } from "pino";
import type { RunLearningSnapshot } from "@trafego/core";
import { createLearningService, type LearningServiceConfig } from "./service.js";
import type { InsertLessonInput, LearnableAgent, LearningRepo } from "./repo.js";

const AGENT: LearnableAgent = { orgId: "org-1", agentId: "agent-1", adAccountId: "acc-1" };
const CONFIG: LearningServiceConfig = {
  historyRuns: 10,
  minRuns: 3,
  minOccurrenceRatio: 0.6,
  redactorModel: "m",
  redactorMaxPerTick: 20,
  decayStaleDays: 30,
  decayArchiveDays: 60,
};

const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger;

/** 3 runs com a mesma campanha zumbi → 1 candidata fact/budget/lower/entity. */
function zombieRuns(): RunLearningSnapshot[] {
  const camp = [{ externalId: "c1", name: "Institucional", tier: "zombie" as const }];
  return [
    { runId: "r1", at: "2026-01-01T00:00:00.000Z", campaigns: camp },
    { runId: "r2", at: "2026-01-02T00:00:00.000Z", campaigns: camp },
    { runId: "r3", at: "2026-01-03T00:00:00.000Z", campaigns: camp },
  ];
}

interface FakeRepoState {
  inserts: InsertLessonInput[];
  reinforces: { id: string; confidence: number; evidenceAt: Date }[];
}

function fakeRepo(
  existing: { id: string; confidence: number | null; lastReinforcedAt: Date | null } | null,
  runs: RunLearningSnapshot[],
  state: FakeRepoState,
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
    applyDecaySweep: async () => ({ staled: 0, archived: 0 }),
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
    const state: FakeRepoState = { inserts: [], reinforces: [] };
    const llm = llmStub("Frase do redator.");
    const svc = createLearningService({ repo: fakeRepo(null, zombieRuns(), state), llm: llm as never, logger, config: CONFIG });
    const r = await svc.distillAgent(AGENT, { remaining: 20 });
    expect(r.created).toBe(1);
    expect(r.reinforced).toBe(0);
    expect(state.inserts[0]?.content).toBe("Frase do redator.");
    // evidência = run mais novo (dedup).
    expect(state.inserts[0]?.evidenceAt.toISOString()).toBe("2026-01-03T00:00:00.000Z");
    expect(state.inserts[0]?.sourceRunId).toBe("r3");
  });

  it("cai no fallback determinístico quando o redator LLM falha (loop funciona sem LLM)", async () => {
    const state: FakeRepoState = { inserts: [], reinforces: [] };
    const llm = llmStub(new Error("llm down"));
    const svc = createLearningService({ repo: fakeRepo(null, zombieRuns(), state), llm: llm as never, logger, config: CONFIG });
    await svc.distillAgent(AGENT, { remaining: 20 });
    expect(state.inserts[0]?.content).toContain("Institucional");
  });

  it("reforça quando há evidência MAIS NOVA que a última incorporada", async () => {
    const state: FakeRepoState = { inserts: [], reinforces: [] };
    const existing = { id: "l1", confidence: 0.2, lastReinforcedAt: new Date("2026-01-02T00:00:00.000Z") };
    const svc = createLearningService({ repo: fakeRepo(existing, zombieRuns(), state), llm: llmStub("x") as never, logger, config: CONFIG });
    const r = await svc.distillAgent(AGENT, { remaining: 20 });
    expect(r.reinforced).toBe(1);
    expect(r.created).toBe(0);
    expect(state.reinforces[0]?.confidence).toBeGreaterThan(0.2);
  });

  it("NÃO reforça sobre a mesma janela já incorporada (dedup do cron diário)", async () => {
    const state: FakeRepoState = { inserts: [], reinforces: [] };
    // já reforçamos até o run mais novo (r3) — um novo tick sobre a mesma janela é no-op.
    const existing = { id: "l1", confidence: 0.4, lastReinforcedAt: new Date("2026-01-03T00:00:00.000Z") };
    const svc = createLearningService({ repo: fakeRepo(existing, zombieRuns(), state), llm: llmStub("x") as never, logger, config: CONFIG });
    const r = await svc.distillAgent(AGENT, { remaining: 20 });
    expect(r.reinforced).toBe(0);
    expect(r.created).toBe(0);
    expect(state.reinforces).toHaveLength(0);
  });

  it("ADIA a criação quando o teto do redator esgotou (não grava texto genérico permanente)", async () => {
    const state: FakeRepoState = { inserts: [], reinforces: [] };
    const llm = llmStub("nunca usado");
    const svc = createLearningService({ repo: fakeRepo(null, zombieRuns(), state), llm: llm as never, logger, config: CONFIG });
    const r = await svc.distillAgent(AGENT, { remaining: 0 });
    expect(llm.complete).not.toHaveBeenCalled();
    expect(r.created).toBe(0); // adiado — vira candidata no próximo tick com orçamento
    expect(state.inserts).toHaveLength(0);
  });

  it("passa runId (run mais novo) ao redator p/ o metering atribuir à conta", async () => {
    const state: FakeRepoState = { inserts: [], reinforces: [] };
    const llm = llmStub("Frase.");
    const svc = createLearningService({ repo: fakeRepo(null, zombieRuns(), state), llm: llm as never, logger, config: CONFIG });
    await svc.distillAgent(AGENT, { remaining: 20 });
    expect(llm.complete).toHaveBeenCalledWith(
      expect.objectContaining({ meta: expect.objectContaining({ orgId: "org-1", type: "learning", runId: "r3" }) }),
    );
  });
});
