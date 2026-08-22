import { describe, expect, it, vi } from "vitest";
import type { StoredInsightMetrics } from "@trafego/shared/types";
import {
  aggregateKpis,
  getFreshMetricsData,
  type FreshMetricsCtx,
  type FreshMetricsDeps,
  type FreshMetricsData,
} from "./fresh-metrics.js";

function m(partial: Partial<StoredInsightMetrics["metrics"]>): StoredInsightMetrics {
  return { metrics: { spend: 0, impressions: 0, clicks: 0, ctr: 0, cpc: 0, cpm: 0, ...partial } };
}

describe("aggregateKpis", () => {
  it("soma a janela e re-deriva CPC/CPM/CTR/CPA/ROAS", () => {
    const k = aggregateKpis([
      m({ spend: 100, impressions: 1000, clicks: 50, conversions: 5, roas: 2 }),
      m({ spend: 100, impressions: 3000, clicks: 50, conversions: 5, roas: 4 }),
    ]);
    expect(k.spend).toBe(200);
    expect(k.impressions).toBe(4000);
    expect(k.clicks).toBe(100);
    expect(k.ctr).toBeCloseTo(100 / 4000);
    expect(k.cpc).toBe(2); // 200/100
    expect(k.cpm).toBe((200 / 4000) * 1000);
    expect(k.conversions).toBe(10);
    expect(k.cpa).toBe(20); // 200/10
    // valor = 2*100 + 4*100 = 600; roas = 600/200 = 3
    expect(k.roas).toBe(3);
  });

  it("sem conversão reportada → conversions/cpa/roas null (não zero)", () => {
    const k = aggregateKpis([m({ spend: 50, impressions: 500, clicks: 10 })]);
    expect(k.conversions).toBeNull();
    expect(k.cpa).toBeNull();
    expect(k.roas).toBeNull();
    expect(k.cpc).toBe(5);
  });

  it("divisões por zero → null", () => {
    const k = aggregateKpis([m({ spend: 0, impressions: 0, clicks: 0 })]);
    expect(k.cpc).toBeNull();
    expect(k.cpm).toBeNull();
    expect(k.ctr).toBeNull();
  });
});

const CTX: FreshMetricsCtx = { orgId: "org-1", agentId: "ag-1", adAccountId: "acc-1" };
const ACCOUNT_ROW = { id: "acc-1", metaAdAccountId: "act_9", status: "active", accountToken: "enc", connToken: null };
const SNAP = [{ date: "2026-08-22", metricsJson: m({ spend: 100, impressions: 1000, clicks: 50, conversions: 5, roas: 3 }) }];

/** Fake db sequencial: cada cadeia awaitada consome o próximo resultado da fila. */
function seqDb(results: unknown[][]) {
  let i = 0;
  const chain: Record<string, unknown> = {};
  for (const method of ["select", "from", "leftJoin", "innerJoin", "where", "orderBy", "limit"]) {
    chain[method] = () => chain;
  }
  chain["then"] = (resolve: (v: unknown) => unknown) => resolve(results[i++] ?? []);
  return chain as never;
}

function makeDeps(results: unknown[][], syncResult = { partial: false, tokenInvalid: false, snapshotsWritten: 1 }) {
  const insightsSync = { sync: vi.fn(async () => syncResult) };
  const deps = {
    db: seqDb(results),
    vault: { decrypt: () => "tok", encrypt: () => ({ cripto: "x", keyVersion: 1 }) },
    insightsSync,
    logger: { warn: vi.fn() },
  } as unknown as FreshMetricsDeps;
  return { deps, insightsSync };
}

describe("getFreshMetricsData", () => {
  it("conta + sync ok → updated:true, KPIs agregados da janela", async () => {
    const { deps, insightsSync } = makeDeps([[ACCOUNT_ROW], SNAP]);
    const res = (await getFreshMetricsData(deps, CTX, { periodDays: 1 })) as FreshMetricsData;
    expect(insightsSync.sync).toHaveBeenCalled();
    expect(res.level).toBe("account");
    expect(res.updated).toBe(true);
    expect(res.kpis.spend).toBe(100);
    expect(res.asOf).toBe("2026-08-22");
  });

  it("sync degradou (partial) → updated:false (mostra o último salvo)", async () => {
    const { deps } = makeDeps([[ACCOUNT_ROW], SNAP], { partial: true, tokenInvalid: false, snapshotsWritten: 0 });
    const res = (await getFreshMetricsData(deps, CTX, {})) as FreshMetricsData;
    expect(res.updated).toBe(false);
    expect(res.kpis.spend).toBe(100);
  });

  it("período sem dado (nem no salvo) → erro claro", async () => {
    const { deps } = makeDeps([[ACCOUNT_ROW], []]);
    const res = await getFreshMetricsData(deps, CTX, { periodDays: 3 });
    expect(res).toHaveProperty("error");
    expect((res as { error: string }).error).toContain("não tenho dados");
  });

  it("conta não encontrada/ativa → erro", async () => {
    const { deps } = makeDeps([[]]);
    const res = await getFreshMetricsData(deps, CTX, {});
    expect(res).toHaveProperty("error");
  });

  it("campanha por nome resolvida → nível campanha", async () => {
    const campaignRows = [{ id: "camp-9", name: "Black Friday", at: new Date() }];
    const { deps } = makeDeps([[ACCOUNT_ROW], campaignRows, SNAP]);
    const res = (await getFreshMetricsData(deps, CTX, { campaign: "black" })) as FreshMetricsData;
    expect(res.level).toBe("campaign");
    expect(res.target).toBe("Black Friday");
    expect(res.kpis.spend).toBe(100);
  });

  it("campanha não encontrada → erro pedindo o nome", async () => {
    const { deps } = makeDeps([[ACCOUNT_ROW], []]);
    const res = await getFreshMetricsData(deps, CTX, { campaign: "inexistente" });
    expect((res as { error: string }).error).toContain("não achei a campanha");
  });

  it("periodDays acima de 7 é limitado a 7", async () => {
    const { deps } = makeDeps([[ACCOUNT_ROW], SNAP]);
    const res = (await getFreshMetricsData(deps, CTX, { periodDays: 30 })) as FreshMetricsData;
    expect(res.periodDays).toBe(7);
  });
});
