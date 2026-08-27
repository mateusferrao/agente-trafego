import { describe, expect, it, vi } from "vitest";
import type { StoredInsightMetrics } from "@trafego/shared/types";
import {
  aggregateKpis,
  getFreshMetricsData,
  type FreshMetricsCtx,
  type FreshMetricsDeps,
  type FreshMetricsData,
} from "./fresh-metrics.js";

function m(
  partial: Partial<StoredInsightMetrics["metrics"]>,
  conversions?: StoredInsightMetrics["conversions"],
): StoredInsightMetrics {
  return {
    metrics: { spend: 0, impressions: 0, clicks: 0, ctr: 0, cpc: 0, cpm: 0, ...partial },
    ...(conversions ? { conversions } : {}),
  };
}

describe("aggregateKpis", () => {
  it("soma a janela e re-deriva CPA/ROAS do ARRAY de conversões (goal de negócio)", () => {
    const k = aggregateKpis(
      [
        m({ spend: 100, impressions: 1000, clicks: 50 }, [{ goal: "purchase", count: 5, value: 200 }]),
        m({ spend: 100, impressions: 3000, clicks: 50 }, [{ goal: "purchase", count: 5, value: 400 }]),
      ],
      { goal: "purchase" },
    );
    expect(k.spend).toBe(200);
    expect(k.impressions).toBe(4000);
    expect(k.clicks).toBe(100);
    expect(k.cpc).toBe(2); // 200/100
    expect(k.conversions).toBe(10);
    expect(k.cpa).toBe(20); // 200/10
    expect(k.roas).toBe(3); // (200+400)/200
    expect(k.conversionGoal).toBe("purchase");
  });

  it("goal de conversa (sem valor) AINDA mostra receita/ROAS das compras (não esconde)", () => {
    const row = m({ spend: 300, impressions: 10000, clicks: 200 }, [
      { goal: "purchase", count: 3, value: 14900 },
      { goal: "messaging_started", count: 115 },
    ]);
    // business goal = conversa: CPA na conversa, MAS roas/revenue da receita rastreada (compras).
    const msg = aggregateKpis([row], { goal: "messaging_started" });
    expect(msg.conversions).toBe(115);
    expect(msg.conversionGoal).toBe("messaging_started");
    expect(msg.cpa).toBeCloseTo(300 / 115);
    expect(msg.revenue).toBe(14900); // NÃO esconde a receita de compra
    expect(msg.roas).toBeCloseTo(14900 / 300); // ROAS do retorno real
    expect(msg.breakdown).toEqual([
      { goal: "purchase", count: 3, value: 14900 },
      { goal: "messaging_started", count: 115, value: null },
    ]);
  });

  it("sem businessGoal → usa a conversão de MAIOR volume (default sensato)", () => {
    const k = aggregateKpis([
      m({ spend: 300, impressions: 10000, clicks: 200 }, [
        { goal: "purchase", count: 3 },
        { goal: "messaging_started", count: 115 },
      ]),
    ]);
    expect(k.conversionGoal).toBe("messaging_started");
    expect(k.conversions).toBe(115);
  });

  it("sem conversão reportada → conversions/cpa/roas/revenue null (aí sim 'Meta não retornou')", () => {
    const k = aggregateKpis([m({ spend: 50, impressions: 500, clicks: 10 })], { goal: "purchase" });
    expect(k.conversions).toBeNull();
    expect(k.cpa).toBeNull();
    expect(k.roas).toBeNull();
    expect(k.revenue).toBeNull();
    expect(k.conversionGoal).toBeNull();
    expect(k.breakdown).toEqual([]);
    expect(k.cpc).toBe(5);
  });

  it("divisões por zero → null", () => {
    const k = aggregateKpis([m({ spend: 0, impressions: 0, clicks: 0 })]);
    expect(k.cpc).toBeNull();
    expect(k.cpm).toBeNull();
    expect(k.ctr).toBeNull();
  });
});

const CTX: FreshMetricsCtx = { orgId: "org-1", agentId: "ag-1", adAccountId: "acc-1", timezone: "America/Sao_Paulo" };
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
    expect(insightsSync.sync).toHaveBeenCalledWith(expect.objectContaining({ levels: ["account"] }));
    expect(res.level).toBe("account");
    expect(res.updated).toBe(true);
    expect(res.kpis.spend).toBe(100);
    expect(res.asOf).toBe("2026-08-22");
  });

  it("cenário noturno BRT: 'hoje' no fuso, não em UTC (repro do bug 24/08 21:42)", async () => {
    const { deps, insightsSync } = makeDeps([[ACCOUNT_ROW], SNAP]);
    // 02:00 UTC = 23:00 BRT de 24/08 — em UTC "hoje" seria 25/08 (o bug).
    (deps as { now?: () => Date }).now = () => new Date("2026-08-25T02:00:00Z");
    const res = (await getFreshMetricsData(deps, CTX, { periodDays: 1 })) as FreshMetricsData; // CTX.timezone = America/Sao_Paulo
    // sync e janela miram 24/08 (BRT), não 25/08 (UTC) → não erra o dia nem o snapshot.
    expect(insightsSync.sync).toHaveBeenCalledWith(expect.objectContaining({ today: "2026-08-24" }));
    expect(res.since).toBe("2026-08-24");
    expect(res.until).toBe("2026-08-24");
  });

  it("recorte ONTEM (dia fechado): untilDaysAgo:1 → since=until=ontem (não o acumulado hoje+ontem)", async () => {
    const { deps } = makeDeps([[ACCOUNT_ROW], SNAP]);
    (deps as { now?: () => Date }).now = () => new Date("2026-08-27T12:00:00Z"); // BRT 09:00 → hoje 27/08
    const res = (await getFreshMetricsData(deps, CTX, { untilDaysAgo: 1 })) as FreshMetricsData;
    expect(res.since).toBe("2026-08-26");
    expect(res.until).toBe("2026-08-26");
    expect(res.periodDays).toBe(1);
  });

  it("recorte de PERÍODO arbitrário: sinceDaysAgo:3 + untilDaysAgo:2 → [3d atrás, 2d atrás]", async () => {
    const { deps } = makeDeps([[ACCOUNT_ROW], SNAP]);
    (deps as { now?: () => Date }).now = () => new Date("2026-08-27T12:00:00Z");
    const res = (await getFreshMetricsData(deps, CTX, { sinceDaysAgo: 3, untilDaysAgo: 2 })) as FreshMetricsData;
    expect(res.since).toBe("2026-08-24");
    expect(res.until).toBe("2026-08-25");
    expect(res.periodDays).toBe(2);
  });

  it("sync degradou (partial) → updated:false (mostra o último salvo)", async () => {
    const { deps } = makeDeps([[ACCOUNT_ROW], SNAP], { partial: true, tokenInvalid: false, snapshotsWritten: 0 });
    const res = (await getFreshMetricsData(deps, CTX, {})) as FreshMetricsData;
    expect(res.updated).toBe(false);
    expect(res.kpis.spend).toBe(100);
  });

  it("exceção inesperada (ex: vault.decrypt corrompido) → erro amigável, nunca vaza a mensagem crua", async () => {
    const { deps } = makeDeps([[ACCOUNT_ROW]]);
    (deps.vault.decrypt as ReturnType<typeof vi.fn>) = vi.fn(() => {
      throw new Error("bad ciphertext: unable to authenticate data (segredo técnico)");
    });
    const res = await getFreshMetricsData(deps, CTX, {});
    expect(res).toHaveProperty("error");
    const msg = (res as { error: string }).error;
    expect(msg).not.toContain("ciphertext");
    expect(msg).not.toContain("segredo técnico");
    expect(deps.logger.warn).toHaveBeenCalled();
  });

  it("exceção inesperada em qualquer leitura do banco → erro amigável (nunca crasha o turno)", async () => {
    const { deps } = makeDeps([[ACCOUNT_ROW]]);
    (deps.db as unknown as { select: () => never }).select = () => {
      throw new Error("connection terminated unexpectedly");
    };
    const res = await getFreshMetricsData(deps, CTX, {});
    expect(res).toHaveProperty("error");
    expect((res as { error: string }).error).not.toContain("connection terminated");
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

  it("campanha por nome resolvida → nível campanha, sync restrito a campaign", async () => {
    const campaignRows = [{ id: "camp-9", name: "Black Friday", at: new Date() }];
    const { deps, insightsSync } = makeDeps([[ACCOUNT_ROW], campaignRows, SNAP]);
    const res = (await getFreshMetricsData(deps, CTX, { campaign: "black" })) as FreshMetricsData;
    expect(res.level).toBe("campaign");
    expect(res.target).toBe("Black Friday");
    expect(res.kpis.spend).toBe(100);
    expect(insightsSync.sync).toHaveBeenCalledWith(expect.objectContaining({ levels: ["campaign"] }));
  });

  it("campanha não encontrada → erro pedindo o nome, SEM chamar a Meta (resolve antes do sync)", async () => {
    const { deps, insightsSync } = makeDeps([[ACCOUNT_ROW], []]);
    const res = await getFreshMetricsData(deps, CTX, { campaign: "inexistente" });
    expect((res as { error: string }).error).toContain("não achei a campanha");
    expect(insightsSync.sync).not.toHaveBeenCalled();
  });

  it("periodDays acima de 7 é limitado a 7", async () => {
    const { deps } = makeDeps([[ACCOUNT_ROW], SNAP]);
    const res = (await getFreshMetricsData(deps, CTX, { periodDays: 30 })) as FreshMetricsData;
    expect(res.periodDays).toBe(7);
  });
});
