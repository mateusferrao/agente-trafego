import { describe, expect, it, vi } from "vitest";
import { agentRuns, agents, entityAnalyses, insightsSnapshots, recommendations } from "@trafego/db";
import type { Approval, ApprovalPort } from "@trafego/shared/ports";
import {
  comparePeriodsData,
  getAccountStatusData,
  getCampaignAnalysisData,
  getMetricsData,
  listAccountsData,
  listPendingData,
  listRecommendationsData,
} from "./read-data.js";

/**
 * db falso ENCADEÁVEL keyed por tabela: `select().from(table).where().orderBy?().limit?()`.
 * `from(table)` fixa o resultado da chamada corrente (via mapa por objeto-tabela); o
 * chain é thenable → `await` resolve as linhas do último `from`. Queries sequenciais
 * (awaited) resetam o alvo a cada `from`, então funções com várias queries funcionam.
 * `innerJoin`/`selectDistinctOn` são passthrough (não mudam o alvo corrente).
 */
function fakeDb(byTable: Map<unknown, unknown[]>) {
  let current: unknown[] = [];
  const chain: Record<string, unknown> = {
    select: () => chain,
    selectDistinctOn: () => chain,
    from: (t: unknown) => {
      current = byTable.get(t) ?? [];
      return chain;
    },
    innerJoin: () => chain,
    where: () => chain,
    orderBy: () => chain,
    limit: () => chain,
    then: (resolve: (v: unknown[]) => unknown) => resolve(current),
  };
  return chain as never;
}

function fakeApprovals(pending: Approval[]): ApprovalPort {
  return {
    listPendingByOrg: vi.fn(async () => pending),
    upsertPending: vi.fn(),
    listPendingByAgent: vi.fn(),
    getById: vi.fn(),
    resolve: vi.fn(),
    getPendingByContact: vi.fn(),
    expireOverdue: vi.fn(),
  } as unknown as ApprovalPort;
}

const ORG = "org-1";
const AGENT = "agent-1";
const ACCOUNT = "acc-1";

function approval(overrides: Record<string, unknown> = {}): Approval {
  return {
    id: "ap-1",
    orgId: ORG,
    agentId: AGENT,
    runId: null,
    contactId: null,
    status: "pending",
    entityLevel: "campaign",
    entityId: "c-99",
    actionType: "pause_entity",
    action: {
      id: "act-1",
      type: "pause_entity",
      target: { level: "campaign", id: "c-99" },
      params: {},
      source: "llm",
      riskLevel: "low",
      reason: "gastou sem venda",
    },
    resolvedReason: null,
    expiresAt: new Date("2026-08-21T00:00:00.000Z"),
    createdAt: new Date("2026-08-20T00:00:00.000Z"),
    ...overrides,
  } as Approval;
}

describe("getAccountStatusData", () => {
  it("com run → shape curado com nota/nota + asOf + contagens", async () => {
    const finishedAt = new Date("2026-08-20T10:00:00.000Z");
    const db = fakeDb(
      new Map<unknown, unknown[]>([
        [
          agentRuns,
          [
            {
              id: "run-1",
              summary: "conta saudável",
              metricsSnapshot: { kpis: { spend: 123.45 }, scorecard: { grade: "B", headline: "vai bem" } },
              createdAt: new Date("2026-08-20T09:00:00.000Z"),
              finishedAt,
            },
          ],
        ],
        [recommendations, [{ id: "r-1" }, { id: "r-2" }]],
      ]),
    );
    const res = await getAccountStatusData(db, AGENT, ORG, fakeApprovals([approval(), approval({ id: "ap-2" })]));
    expect(res).toEqual({
      grade: "B",
      headline: "vai bem",
      summary: "conta saudável",
      spend: 123.45,
      recommendationCount: 2,
      pendingCount: 2,
      asOf: finishedAt.toISOString(),
    });
  });

  it("sem run → hasData:false", async () => {
    const db = fakeDb(new Map<unknown, unknown[]>([[agentRuns, []]]));
    const res = await getAccountStatusData(db, AGENT, ORG, fakeApprovals([]));
    expect(res).toMatchObject({ hasData: false });
    expect((res as { note: string }).note).toBeTruthy();
  });
});

describe("getMetricsData", () => {
  it("com snapshots de conta → soma o gasto + asOf do dia mais recente", async () => {
    const db = fakeDb(
      new Map<unknown, unknown[]>([
        [
          insightsSnapshots,
          [
            { date: "2026-08-18", metricsJson: { metrics: { spend: 10 } } },
            { date: "2026-08-20", metricsJson: { metrics: { spend: 15 } } },
          ],
        ],
      ]),
    );
    const res = await getMetricsData(db, ACCOUNT, ORG, 7);
    expect(res).toEqual({ periodDays: 7, spend: 25, asOf: "2026-08-20", hasData: true });
  });

  it("sem snapshots → hasData:false + asOf 'sem dados'", async () => {
    const db = fakeDb(new Map<unknown, unknown[]>([[insightsSnapshots, []]]));
    const res = await getMetricsData(db, ACCOUNT, ORG, 7);
    expect(res).toEqual({ periodDays: 7, spend: 0, asOf: "sem dados", hasData: false });
  });
});

describe("getCampaignAnalysisData", () => {
  const rows = [
    {
      entityName: "Lançamento Black Friday",
      unitJson: { summary: "escala bem", findings: [{ title: "CTR caindo", severity: "warning" }], flags: [] },
      metricsJson: { spend: 500, cpa: 12, roas: 3 },
      flags: ["scaling"],
      analyzedAt: new Date("2026-08-20T08:00:00.000Z"),
    },
    {
      entityName: "Remarketing geral",
      unitJson: { summary: "estável", findings: [], flags: [] },
      metricsJson: { spend: 100 },
      flags: [],
      analyzedAt: new Date("2026-08-19T08:00:00.000Z"),
    },
  ];

  it("contains case-insensitive → cartão curado com asOf = analyzedAt", async () => {
    const db = fakeDb(new Map<unknown, unknown[]>([[entityAnalyses, rows]]));
    const res = await getCampaignAnalysisData(db, AGENT, "black friday");
    expect(res).toEqual({
      name: "Lançamento Black Friday",
      spend: 500,
      cpa: 12,
      roas: 3,
      summary: "escala bem",
      topFinding: { title: "CTR caindo", severity: "warning" },
      flags: ["scaling"],
      asOf: "2026-08-20T08:00:00.000Z",
    });
  });

  it("nenhuma casa → hasData:false", async () => {
    const db = fakeDb(new Map<unknown, unknown[]>([[entityAnalyses, rows]]));
    const res = await getCampaignAnalysisData(db, AGENT, "inexistente");
    expect(res).toMatchObject({ hasData: false });
  });

  it("várias casam → ambíguo, lista os nomes", async () => {
    const ambiguousRows = [
      { ...rows[0], entityName: "Campanha A - vendas" },
      { ...rows[1], entityName: "Campanha B - vendas" },
    ];
    const db = fakeDb(new Map<unknown, unknown[]>([[entityAnalyses, ambiguousRows]]));
    const res = await getCampaignAnalysisData(db, AGENT, "vendas");
    expect(res).toMatchObject({ hasData: false, ambiguous: true });
    expect((res as { matches: readonly string[] }).matches).toEqual(["Campanha A - vendas", "Campanha B - vendas"]);
  });
});

describe("listRecommendationsData", () => {
  it("com recomendações → array {title, rationale, riskLevel}", async () => {
    const db = fakeDb(
      new Map<unknown, unknown[]>([
        [
          agentRuns,
          [{ id: "run-1", summary: null, metricsSnapshot: null, createdAt: new Date(), finishedAt: new Date() }],
        ],
        [recommendations, [{ title: "Pausar ad X", rationale: "sem venda", riskLevel: "low" }]],
      ]),
    );
    const res = await listRecommendationsData(db, AGENT, ORG);
    expect(res).toEqual([{ title: "Pausar ad X", rationale: "sem venda", riskLevel: "low" }]);
  });

  it("run sem recomendações → hasData:false", async () => {
    const db = fakeDb(
      new Map<unknown, unknown[]>([
        [
          agentRuns,
          [{ id: "run-1", summary: null, metricsSnapshot: null, createdAt: new Date(), finishedAt: new Date() }],
        ],
        [recommendations, []],
      ]),
    );
    const res = await listRecommendationsData(db, AGENT, ORG);
    expect(res).toMatchObject({ hasData: false });
  });

  it("sem run → hasData:false", async () => {
    const db = fakeDb(new Map<unknown, unknown[]>([[agentRuns, []]]));
    const res = await listRecommendationsData(db, AGENT, ORG);
    expect(res).toMatchObject({ hasData: false });
  });
});

describe("listPendingData", () => {
  it("com pendentes → array curado com reason da ação + expiresAt ISO", async () => {
    const res = await listPendingData(fakeApprovals([approval()]), ORG);
    expect(res).toEqual([
      {
        id: "ap-1",
        entityLevel: "campaign",
        entityId: "c-99",
        entityName: null,
        actionType: "pause_entity",
        reason: "gastou sem venda",
        expiresAt: "2026-08-21T00:00:00.000Z",
      },
    ]);
  });

  it("sem pendentes → hasData:false", async () => {
    const res = await listPendingData(fakeApprovals([]), ORG);
    expect(res).toMatchObject({ hasData: false });
  });
});

describe("listAccountsData", () => {
  it("org sem conta ativa → hasData:false", async () => {
    const db = fakeDb(new Map<unknown, unknown[]>([[agents, []]]));
    const res = await listAccountsData(db, ORG);
    expect(res).toMatchObject({ hasData: false });
    expect((res as { note: string }).note).toBeTruthy();
  });

  it("uma conta com análise → entrada única com grade/headline/spend/asOf", async () => {
    const finishedAt = new Date("2026-08-20T10:00:00.000Z");
    const db = fakeDb(
      new Map<unknown, unknown[]>([
        [agents, [{ agentId: "ag-1", accountName: "Clínica X" }]],
        [
          agentRuns,
          [
            {
              agentId: "ag-1",
              metricsSnapshot: { kpis: { spend: 200 }, scorecard: { grade: "B", headline: "vai bem" } },
              createdAt: new Date("2026-08-20T09:00:00.000Z"),
              finishedAt,
            },
          ],
        ],
      ]),
    );
    const res = await listAccountsData(db, ORG);
    expect(res).toEqual({
      accounts: [{ accountName: "Clínica X", hasData: true, grade: "B", headline: "vai bem", spend: 200, asOf: finishedAt.toISOString() }],
      otherAccountNames: [],
      totalCount: 1,
    });
  });

  it("uma conta sem run finalizado → hasData:false na entrada, sem omitir", async () => {
    const db = fakeDb(
      new Map<unknown, unknown[]>([
        [agents, [{ agentId: "ag-1", accountName: "Clínica Y" }]],
        [agentRuns, []],
      ]),
    );
    const res = await listAccountsData(db, ORG);
    expect(res).toEqual({
      accounts: [{ accountName: "Clínica Y", hasData: false, grade: null, headline: null, asOf: "sem dados" }],
      otherAccountNames: [],
      totalCount: 1,
    });
  });

  it("várias contas mistas → pior nota primeiro, sem-análise por último", async () => {
    const db = fakeDb(
      new Map<unknown, unknown[]>([
        [
          agents,
          [
            { agentId: "ag-z", accountName: "Zeta" },
            { agentId: "ag-a", accountName: "Alfa" },
            { agentId: "ag-b", accountName: "Beta" },
          ],
        ],
        [
          agentRuns,
          [
            { agentId: "ag-z", metricsSnapshot: { scorecard: { grade: "A" } }, createdAt: new Date(), finishedAt: new Date() },
            { agentId: "ag-a", metricsSnapshot: { scorecard: { grade: "D" } }, createdAt: new Date(), finishedAt: new Date() },
          ],
        ],
      ]),
    );
    const res = await listAccountsData(db, ORG);
    if ("hasData" in res) throw new Error("esperava PortfolioOverview");
    expect(res.accounts.map((a) => a.accountName)).toEqual(["Alfa", "Zeta", "Beta"]);
  });

  it("empate de nota → desempate alfabético (pt-BR) pelo nome", async () => {
    const db = fakeDb(
      new Map<unknown, unknown[]>([
        [
          agents,
          [
            { agentId: "ag-b", accountName: "Bravo" },
            { agentId: "ag-a", accountName: "Alfa" },
          ],
        ],
        [
          agentRuns,
          [
            { agentId: "ag-b", metricsSnapshot: { scorecard: { grade: "C" } }, createdAt: new Date(), finishedAt: new Date() },
            { agentId: "ag-a", metricsSnapshot: { scorecard: { grade: "C" } }, createdAt: new Date(), finishedAt: new Date() },
          ],
        ],
      ]),
    );
    const res = await listAccountsData(db, ORG);
    if ("hasData" in res) throw new Error("esperava PortfolioOverview");
    expect(res.accounts.map((a) => a.accountName)).toEqual(["Alfa", "Bravo"]);
  });

  it("mais contas que o teto → corta o DETALHE em 8, resto vira só nome (nunca omitido)", async () => {
    const accountRows = Array.from({ length: 11 }, (_, i) => ({
      agentId: `ag-${i + 1}`,
      accountName: `Conta ${String(i + 1).padStart(2, "0")}`,
    }));
    const db = fakeDb(new Map<unknown, unknown[]>([[agents, accountRows], [agentRuns, []]]));
    const res = await listAccountsData(db, ORG);
    if ("hasData" in res) throw new Error("esperava PortfolioOverview");
    expect(res.accounts.length).toBe(8); // = PORTFOLIO_OVERVIEW_MAX_ACCOUNTS
    expect(res.accounts.map((a) => a.accountName)).toEqual([
      "Conta 01", "Conta 02", "Conta 03", "Conta 04", "Conta 05", "Conta 06", "Conta 07", "Conta 08",
    ]);
    expect(res.otherAccountNames).toEqual(["Conta 09", "Conta 10", "Conta 11"]);
    expect(res.totalCount).toBe(11);
  });

  it("totalCount reflete o total, sem overflow quando cabe tudo no cap", async () => {
    const db = fakeDb(
      new Map<unknown, unknown[]>([
        [
          agents,
          [
            { agentId: "ag-1", accountName: "Um" },
            { agentId: "ag-2", accountName: "Dois" },
          ],
        ],
        [agentRuns, []],
      ]),
    );
    const res = await listAccountsData(db, ORG);
    if ("hasData" in res) throw new Error("esperava PortfolioOverview");
    expect(res.otherAccountNames).toEqual([]);
    expect(res.totalCount).toBe(2);
  });
});

describe("comparePeriodsData", () => {
  it("separa gasto da janela atual vs anterior e calcula a variação %", async () => {
    const db = fakeDb(
      new Map<unknown, unknown[]>([
        [
          insightsSnapshots,
          [
            { date: "2026-08-20", level: "account", metricsJson: { metrics: { spend: 100 } } },
            { date: "2026-08-10", level: "account", metricsJson: { metrics: { spend: 50 } } },
          ],
        ],
      ]),
    );
    const now = () => new Date("2026-08-21T00:00:00.000Z");
    const res = await comparePeriodsData(db, ACCOUNT, ORG, 7, now);
    expect(res.current).toBe(100);
    expect(res.previous).toBe(50);
    expect(res.deltaPct).toBe(100);
  });
});
