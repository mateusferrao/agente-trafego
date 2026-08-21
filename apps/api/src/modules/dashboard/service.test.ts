import { describe, expect, it, vi } from "vitest";
import { createDashboardService } from "./service.js";

/**
 * DB fake chainável: cada método terminal (select/selectDistinctOn) inicia uma nova
 * query que consome o próximo resultado da fila; os demais (from/join/where/orderBy/
 * groupBy/limit) encadeiam; o nó é thenable (await resolve o resultado da query).
 */
function fakeDb(queue: unknown[][]) {
  let i = 0;
  const makeChain = () => {
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
  return new Proxy({}, { get: () => makeChain }) as never;
}

const NOW = () => new Date("2026-08-20T12:00:00Z");

function acctSnap(date: string, spend: number, purchases: number) {
  return {
    adAccountId: "a1", // usado no agrupamento do panorama (liveTotalsBatch)
    entityLevel: "account",
    entityId: "ACT1",
    date,
    metricsJson: {
      metrics: { spend, impressions: 1000, clicks: 20, ctr: 0, cpc: 0, cpm: 0 },
      conversions: [{ goal: "purchase", count: purchases, value: spend * 4 }],
    },
  };
}

describe("createDashboardService.liveMetrics", () => {
  it("computa KPIs ao vivo + as-of da conta (org-scoped)", async () => {
    const syncedAt = new Date("2026-08-20T11:30:00Z");
    const db = fakeDb([
      [{ currency: "BRL" }], // account
      [{ goals: { conversionGoal: "purchase" } }], // agent
      [acctSnap("2026-08-19", 100, 5), acctSnap("2026-08-20", 100, 5)], // snapshots (janela)
      [{ latest: syncedAt }], // max(updated_at)
    ]);
    const service = createDashboardService({ db, scheduler: {} as never, windowDays: 7, baselineDays: 7, freshThresholdMin: 120, now: NOW });

    const out = await service.liveMetrics("org-1" as never, "acc-1");
    expect(out.currency).toBe("BRL");
    expect(out.asOf).toBe(syncedAt.toISOString());
    expect(out.window).toEqual({ since: "2026-08-14", until: "2026-08-20" });
    expect(out.totals).not.toBeNull();
    expect(out.totals!.spend).toBe(200);
    expect(out.totals!.cpa).toBeCloseTo(20); // 200 / 10 compras
  });

  it("conta inexistente → 404", async () => {
    const db = fakeDb([[]]); // account vazio
    const service = createDashboardService({ db, scheduler: {} as never, windowDays: 7, baselineDays: 7, freshThresholdMin: 120, now: NOW });
    await expect(service.liveMetrics("org-1" as never, "nope")).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe("createDashboardService.dashboard", () => {
  it("monta panorama + atenção + atividade + pendências cross-conta", async () => {
    const db = fakeDb([
      // 1) contas
      [{ accountId: "a1", agentId: "ag1", agentPaused: false, name: "Loja A", currency: "BRL", goals: { conversionGoal: "purchase" }, tokenStatus: "valid" }],
      // 2) última análise por agente (grade C → atenção)
      [{ agentId: "ag1", grade: "C", finishedAt: new Date("2026-08-20T11:00:00Z") }],
      // 3) pendências por conta
      [{ accountId: "a1", c: 2 }],
      // 4a) snapshots (janela) · 4b) as-of
      [acctSnap("2026-08-20", 100, 5)],
      [{ accountId: "a1", latest: new Date("2026-08-20T11:30:00Z") }],
      // 5) atividade recente (ação por chat → runId null)
      [{ id: "tc1", toolKey: "pause_entity", args: { target: { name: "Campanha X" } }, runId: null, at: new Date("2026-08-20T10:00:00Z"), accountId: "a1", accountName: "Loja A" }],
      // 6) desperdício cross-conta (waste.wastedSpend da última análise, texto do jsonb #>>)
      [{ accountId: "a1", accountName: "Loja A", wastedSpend: "120" }],
    ]);
    const service = createDashboardService({ db, scheduler: {} as never, windowDays: 7, baselineDays: 7, freshThresholdMin: 120, now: NOW });

    const out = await service.dashboard("org-1" as never);
    expect(out.pendingCount).toBe(2);
    expect(out.panorama).toHaveLength(1);
    const card = out.panorama[0]!;
    expect(card.grade).toBe("C");
    expect(card.live).not.toBeNull();
    expect(card.reasons).toEqual(["bad_grade", "pending"]); // token válido + análise recente
    expect(out.attention).toHaveLength(1); // tem motivos
    expect(out.recentActivity).toHaveLength(1);
    expect(out.recentActivity[0]).toMatchObject({ type: "action_applied", entityName: "Campanha X", fromChat: true });
    expect(out.waste.totalWasted).toBe(120);
    expect(out.waste.accounts).toEqual([{ accountId: "a1", accountName: "Loja A", wastedSpend: 120 }]);
  });

  it("org sem contas → painel vazio (sem quebrar)", async () => {
    const db = fakeDb([[]]);
    const service = createDashboardService({ db, scheduler: {} as never, windowDays: 7, baselineDays: 7, freshThresholdMin: 120, now: NOW });
    const out = await service.dashboard("org-1" as never);
    expect(out).toEqual({ pendingCount: 0, attention: [], recentActivity: [], panorama: [], waste: { totalWasted: 0, accounts: [] } });
  });
});

describe("createDashboardService.panorama", () => {
  it("retorna os cards por conta ordenados por gasto desc (lista de Contas)", async () => {
    const db = fakeDb([
      // contas (2)
      [
        { accountId: "a1", agentId: "ag1", agentPaused: false, name: "Loja A", currency: "BRL", goals: {}, tokenStatus: "valid" },
        { accountId: "a2", agentId: "ag2", agentPaused: false, name: "Loja B", currency: "BRL", goals: {}, tokenStatus: "valid" },
      ],
      [], // latestRuns (sem análise)
      [], // pendências
      [
        { ...acctSnap("2026-08-20", 50, 0), adAccountId: "a1" },
        { ...acctSnap("2026-08-20", 300, 0), adAccountId: "a2" },
      ],
      [
        { accountId: "a1", latest: new Date("2026-08-20T11:00:00Z") },
        { accountId: "a2", latest: new Date("2026-08-20T11:00:00Z") },
      ],
    ]);
    const service = createDashboardService({ db, scheduler: {} as never, windowDays: 7, baselineDays: 7, freshThresholdMin: 120, now: NOW });
    const cards = await service.panorama("org-1" as never);
    expect(cards.map((c) => c.accountName)).toEqual(["Loja B", "Loja A"]); // maior gasto primeiro
    expect(cards[0]!.live!.spend).toBe(300);
  });
});

describe("createDashboardService.requestRefresh", () => {
  it("enfileira o sync-only da conta", async () => {
    const enqueue = vi.fn(async () => {});
    const db = fakeDb([[{ id: "acc-1" }]]);
    const service = createDashboardService({
      db,
      scheduler: { enqueue } as never,
      windowDays: 7,
      baselineDays: 7,
      freshThresholdMin: 120,
      now: NOW,
    });
    const out = await service.requestRefresh("org-1" as never, "acc-1");
    expect(out).toEqual({ enqueued: true });
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ name: "insights-sync-run", idempotencyKey: "sync:acc-1:now" }),
    );
  });

  it("conta inexistente → 404 (não enfileira)", async () => {
    const enqueue = vi.fn(async () => {});
    const db = fakeDb([[]]);
    const service = createDashboardService({
      db,
      scheduler: { enqueue } as never,
      windowDays: 7,
      baselineDays: 7,
      freshThresholdMin: 120,
      now: NOW,
    });
    await expect(service.requestRefresh("org-1" as never, "nope")).rejects.toMatchObject({ statusCode: 404 });
    expect(enqueue).not.toHaveBeenCalled();
  });
});
