import { describe, expect, it, vi } from "vitest";
import type { Database } from "@trafego/db";
import type { OrgId } from "@trafego/shared/types";
import { AGENT_RUNS_QUEUE } from "@trafego/shared";
import { createRunsService, toCampaignAnalysisOutput } from "./service.js";

const ORG = "org-1" as OrgId;

function makeScheduler() {
  return {
    enqueue: vi.fn(async (_job: { queue: string; name: string; payload: Record<string, unknown> }) => undefined),
    upsertSchedule: vi.fn(),
    removeSchedule: vi.fn(),
  };
}

/** DB falso: select→...→limit() retorna por ordem; insert captura + retorna run. */
function makeFakeDb(inFlight: unknown[], insertReturning: unknown[] = [{ id: "run-1" }]) {
  const db = {
    select: () => ({
      from: () => ({ where: () => ({ limit: async () => inFlight }) }),
    }),
    insert: () => ({ values: () => ({ returning: async () => insertReturning }) }),
  };
  return db as unknown as Database;
}

describe("runs.trigger", () => {
  it("cria run pending e enfileira o job execute", async () => {
    const scheduler = makeScheduler();
    const service = createRunsService({
      db: makeFakeDb([]), // nada em andamento
      scheduler,
      metering: { llmCostInPeriod: async () => 0, record: vi.fn(), summarize: vi.fn() } as never,
      ensureAgent: async () => ({ agentId: "ag-1" }),
      costCapUsd: 0,
    });

    const result = await service.trigger(ORG, "acc-1");

    expect(result).toEqual({ runId: "run-1", status: "pending" });
    expect(scheduler.enqueue).toHaveBeenCalledOnce();
    const job = scheduler.enqueue.mock.calls[0]![0];
    expect(job.queue).toBe(AGENT_RUNS_QUEUE);
    expect(job.payload).toMatchObject({ mode: "execute", runId: "run-1", agentId: "ag-1", adAccountId: "acc-1" });
  });

  it("409 quando já há análise em andamento (não enfileira)", async () => {
    const scheduler = makeScheduler();
    const service = createRunsService({
      db: makeFakeDb([{ id: "run-x" }]), // run em andamento
      scheduler,
      metering: { llmCostInPeriod: async () => 0, record: vi.fn(), summarize: vi.fn() } as never,
      ensureAgent: async () => ({ agentId: "ag-1" }),
      costCapUsd: 0,
    });

    await expect(service.trigger(ORG, "acc-1")).rejects.toMatchObject({ statusCode: 409 });
    expect(scheduler.enqueue).not.toHaveBeenCalled();
  });
});

describe("toCampaignAnalysisOutput (S8 — orçamento curado no cartão da campanha)", () => {
  const BASE_ROW = { entityId: "c1", name: "Campanha X", unitJson: {}, metricsJson: {}, flags: [], tier: null };

  it("sem curatedJson (linha de antes da fase) → budget/atBudgetCeiling/isCBO null, não omitidos", () => {
    const out = toCampaignAnalysisOutput(BASE_ROW, false);
    expect(out.budget).toBeNull();
    expect(out.atBudgetCeiling).toBeNull();
    expect(out.isCBO).toBeNull();
  });

  it("com curatedJson (CBO) → expõe budget/atBudgetCeiling/isCBO", () => {
    const out = toCampaignAnalysisOutput(
      { ...BASE_ROW, curatedJson: { isCBO: true, budget: { dailyMajor: 150 }, atBudgetCeiling: true } },
      false,
    );
    expect(out.budget).toEqual({ dailyMajor: 150 });
    expect(out.atBudgetCeiling).toBe(true);
    expect(out.isCBO).toBe(true);
  });

  it("com curatedJson (ABO, sem budget próprio) → isCBO false, budget null", () => {
    const out = toCampaignAnalysisOutput({ ...BASE_ROW, curatedJson: { isCBO: false } }, false);
    expect(out.isCBO).toBe(false);
    expect(out.budget).toBeNull();
  });
});
