import { describe, expect, it, vi } from "vitest";
import type { Database } from "@trafego/db";
import type { OrgId } from "@trafego/shared/types";
import { AGENT_RUNS_QUEUE } from "@trafego/shared";
import { createRunsService, toCampaignAnalysisOutput, toGapCampaignOutput } from "./service.js";

const ORG = "org-1" as OrgId;

/**
 * DB fake por FILA (mesmo padrão de billing/service.test.ts): cada `select(...)`
 * consome o próximo resultado da fila, independente da tabela/encadeamento.
 */
function fakeQueueDb(queue: unknown[][]): Database {
  let i = 0;
  const make = () => {
    const result = queue[i++] ?? [];
    const chain: unknown = new Proxy(
      {},
      {
        get(_t, prop) {
          if (prop === "then") return (res: (v: unknown) => void) => res(result);
          return () => chain;
        },
      },
    );
    return chain;
  };
  return new Proxy({}, { get: () => make }) as unknown as Database;
}

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
      adsPlatform: {} as never,
      vault: {} as never,
      liveGapCheckTimeoutMs: 1000,
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
      adsPlatform: {} as never,
      vault: {} as never,
      liveGapCheckTimeoutMs: 1000,
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

  it("veio de entity_analyses → noDataYet sempre false (já tem alguma análise)", () => {
    const out = toCampaignAnalysisOutput(BASE_ROW, false);
    expect(out.noDataYet).toBe(false);
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

  it("sincronização: sem deactivatedSince → null (ainda ativa ou nunca marcada)", () => {
    const out = toCampaignAnalysisOutput({ ...BASE_ROW, curatedJson: { isCBO: true } }, false);
    expect(out.deactivatedSince).toBeNull();
  });

  it("sincronização: curatedJson.deactivatedSince presente → propaga pro cartão da UI", () => {
    const out = toCampaignAnalysisOutput({ ...BASE_ROW, curatedJson: { isCBO: true, deactivatedSince: "2026-08-25T00:00:00.000Z" } }, false);
    expect(out.deactivatedSince).toBe("2026-08-25T00:00:00.000Z");
  });
});

describe("toGapCampaignOutput (gap irmão do deactivatedSince — campanha ativa sem análise)", () => {
  it("tudo vazio/null + noDataYet true — nunca inventa métrica/tier", () => {
    const out = toGapCampaignOutput({ id: "c-novo", name: "Campanha Nova" }, false);
    expect(out).toEqual({
      externalId: "c-novo",
      name: "Campanha Nova",
      metrics: { spend: 0 },
      summary: null,
      topFinding: null,
      flags: [],
      tier: null,
      stage: null,
      muted: false,
      budget: null,
      atBudgetCeiling: null,
      isCBO: null,
      deactivatedSince: null,
      noDataYet: true,
    });
  });

  it("propaga o estado silenciado quando o dono já mutou o id ANTES de qualquer análise", () => {
    const out = toGapCampaignOutput({ id: "c-novo", name: "Campanha Nova" }, true);
    expect(out.muted).toBe(true);
  });
});

describe("runs.campaignAnalyses — gap de campanha ativa sem análise ainda", () => {
  function makeService(dbQueue: unknown[][], listEntities: ReturnType<typeof vi.fn>) {
    return createRunsService({
      db: fakeQueueDb(dbQueue),
      scheduler: makeScheduler(),
      metering: { llmCostInPeriod: async () => 0, record: vi.fn(), summarize: vi.fn() } as never,
      ensureAgent: async () => ({ agentId: "ag-1" }),
      costCapUsd: 0,
      adsPlatform: { listEntities } as never,
      vault: { decrypt: () => "token-decriptado" } as never,
      liveGapCheckTimeoutMs: 1000,
    });
  }

  it("soma campanha ATIVA na Meta que ainda não tem linha em entity_analyses", async () => {
    const listEntities = vi.fn(async () => [
      { id: "c1", level: "campaign", name: "Cached A", status: "active" },
      { id: "c2", level: "campaign", name: "Nova Sem Análise", status: "active" },
      { id: "c3", level: "campaign", name: "Pausada Antiga", status: "paused" },
    ]);
    const service = makeService(
      [
        [{ id: "ag-1" }], // agents
        [{ entityId: "c1", name: "Cached A", unitJson: {}, metricsJson: {}, flags: [], tier: null, curatedJson: null, analyzedAt: new Date() }], // entity_analyses
        [], // agentMutedEntities
        [{ metaAdAccountId: "act_123", accountToken: { ciphertext: "x", iv: "y", tag: "z", keyVersion: 1 }, connToken: null }], // loadAccountRef
      ],
      listEntities,
    );

    const out = await service.campaignAnalyses(ORG, "acc-1");

    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ externalId: "c1", noDataYet: false });
    expect(out[1]).toMatchObject({ externalId: "c2", name: "Nova Sem Análise", noDataYet: true, muted: false });
    expect(listEntities).toHaveBeenCalledWith({ adAccountId: "act_123", accessToken: "token-decriptado" }, "campaign");
  });

  it("Meta ao vivo falhando degrada em silêncio — só devolve o cache, sem quebrar", async () => {
    const listEntities = vi.fn(async () => {
      throw new Error("Meta indisponível");
    });
    const service = makeService(
      [
        [{ id: "ag-1" }],
        [{ entityId: "c1", name: "Cached A", unitJson: {}, metricsJson: {}, flags: [], tier: null, curatedJson: null, analyzedAt: new Date() }],
        [],
        [{ metaAdAccountId: "act_123", accountToken: { ciphertext: "x", iv: "y", tag: "z", keyVersion: 1 }, connToken: null }],
      ],
      listEntities,
    );

    const out = await service.campaignAnalyses(ORG, "acc-1");

    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ externalId: "c1" });
  });
});
