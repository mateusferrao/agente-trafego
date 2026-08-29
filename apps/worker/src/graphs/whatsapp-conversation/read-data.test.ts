import { describe, expect, it, vi } from "vitest";
import { adAccounts, adCreatives, agentRuns, agents, campaignDrafts, entityAnalyses, insightsSnapshots, recommendations } from "@trafego/db";
import type { Approval, ApprovalPort } from "@trafego/shared/ports";
import type { PerformanceTier } from "@trafego/shared";
import {
  comparePeriodsData,
  getAccountStatusData,
  getCampaignAnalysisData,
  getMetricsData,
  listAccountsData,
  listCampaignsData,
  describeDraftAudience,
  describeDraftCreative,
  listPendingData,
  listRecommendationsData,
  renderWhatsappNumber,
  resolveWhatsappNumber,
  pickAdIdsToRefresh,
  TOP_CREATIVES_LIMIT,
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
    leftJoin: () => chain,
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

describe("pickAdIdsToRefresh (fresh=true refresca só o top-N que será exibido)", () => {
  it("ranqueia (campeã→pior) e limita ao TOP_CREATIVES_LIMIT", () => {
    // mais anúncios que o teto, tiers embaralhados → só os melhores, em ordem.
    const rows: { adId: string; tier: PerformanceTier | null; roas: number | null; cpa: number | null; spend: number | null }[] = [
      { adId: "zombie", tier: "zombie", roas: null, cpa: null, spend: 10 },
      { adId: "winner", tier: "winner", roas: 5, cpa: 2, spend: 100 },
      { adId: "perf", tier: "performer", roas: 3, cpa: 4, spend: 50 },
      { adId: "under", tier: "underperformer", roas: 1, cpa: 8, spend: 30 },
      { adId: "notier", tier: null, roas: null, cpa: null, spend: 5 },
      { adId: "winner2", tier: "winner", roas: 4, cpa: 3, spend: 80 },
    ];
    const ids = pickAdIdsToRefresh(rows);
    expect(ids.length).toBeLessThanOrEqual(TOP_CREATIVES_LIMIT);
    expect(ids[0]).toBe("winner"); // melhor tier + melhor roas
    expect(ids).not.toContain("notier"); // ficou de fora do top-N (6 > 5)
  });

  it("sem linhas persistidas → nada a refrescar", () => {
    expect(pickAdIdsToRefresh([])).toEqual([]);
  });
});

describe("describeDraftAudience (público do rascunho pelo MODO, sem jargão nem chamada Meta)", () => {
  it("reuse_adset → herda o público que já converte", () => {
    expect(describeDraftAudience({ kind: "reuse_adset", sourceAdsetId: "AS1" })).toContain("herda o público");
  });

  it("advantage_plus → a Meta escolhe (amplo), sem citar 'Advantage+'", () => {
    const txt = describeDraftAudience({ kind: "advantage_plus" });
    expect(txt.toLowerCase()).toContain("meta escolhe");
    expect(txt.toLowerCase()).not.toContain("advantage");
  });

  it("sem targeting → cai no amplo (default seguro)", () => {
    expect(describeDraftAudience(undefined).toLowerCase()).toContain("meta escolhe");
  });
});

describe("describeDraftCreative (rótulo do criativo do rascunho, do BANCO — sem chamar a Meta)", () => {
  const reuseVideo = { assetId: "AD1", format: "video" as const, origin: "reuse" as const };
  it("reuse com título conhecido → nomeia o anúncio real + formato", () => {
    const txt = describeDraftCreative("from_scratch", reuseVideo, new Map([["AD1", "Agende sua avaliação"]]));
    expect(txt).toContain("Agende sua avaliação");
    expect(txt).toContain("vídeo");
  });
  it("reuse sem título salvo → fala genérico honesto (não inventa)", () => {
    const txt = describeDraftCreative("from_scratch", reuseVideo, new Map());
    expect(txt).toContain("já veicula");
    expect(txt).toContain("vídeo");
  });
  it("upload da biblioteca → diz biblioteca + formato", () => {
    const txt = describeDraftCreative("from_scratch", { assetId: "u1", format: "image", origin: "upload" }, new Map());
    expect(txt.toLowerCase()).toContain("biblioteca");
    expect(txt).toContain("imagem");
  });
  it("duplicate (sem creative no spec) → fala do criativo do vencedor duplicado", () => {
    expect(describeDraftCreative("duplicate", undefined, new Map()).toLowerCase()).toContain("vencedor");
  });
});

const ORG = "org-1";
const AGENT = "agent-1";
const ACCOUNT = "acc-1";

function approval(overrides: Record<string, unknown> = {}): Approval {
  return {
    id: "ap-1",
    kind: "action",
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

  it("expõe o money-shot (waste) quando material no snapshot", async () => {
    const db = fakeDb(
      new Map<unknown, unknown[]>([
        [
          agentRuns,
          [
            {
              id: "run-1",
              summary: "s",
              metricsSnapshot: {
                kpis: { spend: 500 },
                scorecard: { grade: "C", headline: "h" },
                waste: {
                  wastedSpend: 12000,
                  wastedPct: 24,
                  pareto: { misallocated: [{ name: "Campanha X", spendPct: 40, resultPct: 8 }] },
                },
              },
              createdAt: new Date(),
              finishedAt: new Date(),
            },
          ],
        ],
        [recommendations, []],
      ]),
    );
    const res = await getAccountStatusData(db, AGENT, ORG, fakeApprovals([]));
    expect(res).toMatchObject({
      waste: {
        wastedSpend: 12000,
        wastedPct: 24,
        misallocated: [{ name: "Campanha X", spendPct: 40, resultPct: 8 }],
      },
    });
  });

  it("omite waste quando não há desperdício material (não polui a resposta)", async () => {
    const db = fakeDb(
      new Map<unknown, unknown[]>([
        [
          agentRuns,
          [
            {
              id: "run-1",
              summary: "s",
              metricsSnapshot: { kpis: { spend: 500 }, scorecard: { grade: "A" }, waste: { wastedSpend: 0, wastedPct: 0 } },
              createdAt: new Date(),
              finishedAt: new Date(),
            },
          ],
        ],
        [recommendations, []],
      ]),
    );
    const res = await getAccountStatusData(db, AGENT, ORG, fakeApprovals([]));
    expect(res).not.toHaveProperty("waste");
  });
});

describe("getMetricsData", () => {
  it("com snapshots de conta → soma gasto+conversões/receita (array de conversões) + asOf do dia mais recente", async () => {
    const db = fakeDb(
      new Map<unknown, unknown[]>([
        [
          insightsSnapshots,
          [
            { date: "2026-08-18", metricsJson: { metrics: { spend: 10 }, conversions: [{ goal: "purchase", count: 1, value: 50 }] } },
            { date: "2026-08-20", metricsJson: { metrics: { spend: 15 }, conversions: [{ goal: "purchase", count: 2, value: 80 }] } },
          ],
        ],
        [agents, []],
      ]),
    );
    const res = await getMetricsData(db, ACCOUNT, ORG, AGENT, 7, "America/Sao_Paulo", () => new Date("2026-08-20T12:00:00Z"));
    expect(res.hasData).toBe(true);
    if (!res.hasData) return;
    expect(res.spend).toBe(25);
    expect(res.asOf).toBe("2026-08-20");
    expect(res.conversions).toBe(3);
    expect(res.revenue).toBe(130);
    expect(res.attributionNote).toBeDefined(); // asOf recente → ainda pode subir
  });

  it("período antigo (asOf >7 dias de hoje) → sem attributionNote (já fechado)", async () => {
    const db = fakeDb(
      new Map<unknown, unknown[]>([
        [insightsSnapshots, [{ date: "2026-08-01", metricsJson: { metrics: { spend: 10 } } }]],
        [agents, []],
      ]),
    );
    const res = await getMetricsData(db, ACCOUNT, ORG, AGENT, 7, "America/Sao_Paulo", () => new Date("2026-08-20T12:00:00Z"));
    expect(res.hasData).toBe(true);
    if (!res.hasData) return;
    expect(res.attributionNote).toBeUndefined();
  });

  it("sem snapshots → hasData:false + asOf 'sem dados'", async () => {
    const db = fakeDb(new Map<unknown, unknown[]>([[insightsSnapshots, []]]));
    const res = await getMetricsData(db, ACCOUNT, ORG, AGENT, 7, "America/Sao_Paulo");
    expect(res).toEqual({ periodDays: 7, spend: 0, asOf: "sem dados", hasData: false });
  });

  it("businessGoal do agente (goals.conversionGoal) vence a conversão de maior volume, mas NÃO esconde a receita de compra", async () => {
    const db = fakeDb(
      new Map<unknown, unknown[]>([
        [
          insightsSnapshots,
          [
            {
              date: "2026-08-20",
              metricsJson: {
                metrics: { spend: 300 },
                conversions: [
                  { goal: "purchase", count: 2, value: 400 },
                  { goal: "messaging_started", count: 50 },
                ],
              },
            },
          ],
        ],
        [agents, [{ goals: { conversionGoal: "messaging_started" } }]],
      ]),
    );
    const res = await getMetricsData(db, ACCOUNT, ORG, AGENT, 7, "America/Sao_Paulo", () => new Date("2026-08-20T12:00:00Z"));
    expect(res.hasData).toBe(true);
    if (!res.hasData) return;
    expect(res.conversionGoal).toBe("messaging_started");
    expect(res.conversions).toBe(50);
    expect(res.cpa).toBeCloseTo(300 / 50);
    expect(res.revenue).toBe(400);
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

  it("várias casam → ambíguo, opções numeradas COM id (âncora anti-misatribuição)", async () => {
    const ambiguousRows = [
      { ...rows[0], entityId: "cmp-a", entityName: "Campanha vendas — Cópia 01" },
      { ...rows[1], entityId: "cmp-b", entityName: "Campanha vendas — Cópia 02" },
    ];
    const db = fakeDb(new Map<unknown, unknown[]>([[entityAnalyses, ambiguousRows]]));
    const res = await getCampaignAnalysisData(db, AGENT, "Campanha vendas");
    expect(res).toMatchObject({ hasData: false, ambiguous: true });
    const opts = (res as { options: readonly { n: number; id: string; name: string }[] }).options;
    expect(opts.map((o) => o.id).sort()).toEqual(["cmp-a", "cmp-b"]);
    expect(opts.map((o) => o.n)).toEqual([1, 2]);
  });
});

describe("listCampaignsData", () => {
  const rows = [
    {
      entityId: "c-small",
      entityName: "Remarketing",
      metricsJson: { spend: 100, conversions: 5, cpa: 20, roas: 4, revenue: 400 },
      tier: "performer",
      analyzedAt: new Date("2026-08-20T08:00:00.000Z"),
    },
    {
      entityId: "c-big",
      entityName: "Prospecção",
      metricsJson: { spend: 500, conversions: 40, cpa: 12.5 },
      tier: "underperformer",
      analyzedAt: new Date("2026-08-20T08:00:00.000Z"),
    },
    // linha antiga da MESMA campanha c-big → deve ser ignorada (dedup, fica a mais recente).
    {
      entityId: "c-big",
      entityName: "Prospecção",
      metricsJson: { spend: 999 },
      tier: "winner",
      analyzedAt: new Date("2026-08-19T08:00:00.000Z"),
    },
  ];

  it("lista todas as campanhas (dedup por id) ordenadas por gasto desc", async () => {
    const db = fakeDb(new Map<unknown, unknown[]>([[entityAnalyses, rows]]));
    const res = await listCampaignsData(db, AGENT);
    expect(res).toMatchObject({ hasData: true });
    const r = res as { hasData: true; campaigns: Array<Record<string, unknown>> };
    expect(r.campaigns.map((c) => c.id)).toEqual(["c-big", "c-small"]); // gasto 500 > 100; c-big só 1x
    expect(r.campaigns[0]).toMatchObject({ name: "Prospecção", spend: 500, conversions: 40, cpa: 12.5, tier: "underperformer" });
    expect(r.campaigns[1]).toMatchObject({ name: "Remarketing", spend: 100, roas: 4, revenue: 400 });
  });

  it("nenhuma campanha analisada → hasData:false", async () => {
    const db = fakeDb(new Map<unknown, unknown[]>([[entityAnalyses, []]]));
    const res = await listCampaignsData(db, AGENT);
    expect(res).toMatchObject({ hasData: false });
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
    const res = await listPendingData(fakeDb(new Map()), fakeApprovals([approval()]), ORG);
    expect(res).toEqual([
      {
        kind: "action",
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
    const res = await listPendingData(fakeDb(new Map()), fakeApprovals([]), ORG);
    expect(res).toMatchObject({ hasData: false });
  });

  it("P0.1: aprovação de ATIVAÇÃO → item 'ativação' com resumo do rascunho", async () => {
    const activationApproval = {
      id: "ap-act-1",
      kind: "activation",
      orgId: ORG,
      agentId: AGENT,
      runId: null,
      contactId: null,
      status: "pending",
      draftId: "draft-1",
      resolvedReason: null,
      expiresAt: new Date("2026-08-21T00:00:00.000Z"),
      createdAt: new Date("2026-08-20T00:00:00.000Z"),
    };
    const draftRow = {
      id: "draft-1",
      kind: "from_scratch",
      spec: { version: 1, currency: "BRL", dailyBudgetMinor: 5000, activation: "active", objective: "sale" },
    };
    const db = fakeDb(new Map([[campaignDrafts, [draftRow]]]));
    const res = await listPendingData(db, fakeApprovals([activationApproval as unknown as Approval]), ORG);
    expect(res).toEqual([
      { kind: "activation", id: "ap-act-1", reason: expect.stringContaining("ativar"), expiresAt: "2026-08-21T00:00:00.000Z" },
    ]);
  });

  it("rascunho de CRIAÇÃO entra no list_pending (aprovável/recusável por id, não só no eco de 30min)", async () => {
    const draftApproval = {
      id: "ap-draft-1",
      kind: "draft",
      orgId: ORG,
      agentId: AGENT,
      runId: null,
      status: "pending",
      draftId: "draft-9",
      resolvedReason: null,
      expiresAt: new Date("2026-08-29T00:00:00.000Z"),
      createdAt: new Date("2026-08-28T00:00:00.000Z"),
    };
    const draftRow = {
      id: "draft-9",
      kind: "from_scratch",
      spec: { version: 1, currency: "BRL", dailyBudgetMinor: 5000, activation: "active", objective: "lead" },
    };
    const db = fakeDb(new Map([[campaignDrafts, [draftRow]]]));
    const res = await listPendingData(db, fakeApprovals([draftApproval as unknown as Approval]), ORG);
    expect(res).toEqual([
      { kind: "draft", id: "ap-draft-1", reason: expect.stringContaining("criar"), expiresAt: "2026-08-29T00:00:00.000Z" },
    ]);
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
        [agents, [{ agentId: "ag-1", accountName: "Clínica X", currency: "BRL" }]],
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
      accounts: [{ accountName: "Clínica X", currency: "BRL", hasData: true, grade: "B", headline: "vai bem", spend: 200, asOf: finishedAt.toISOString() }],
      otherAccountNames: [],
      totalCount: 1,
    });
  });

  it("uma conta sem run finalizado → hasData:false na entrada, sem omitir", async () => {
    const db = fakeDb(
      new Map<unknown, unknown[]>([
        [agents, [{ agentId: "ag-1", accountName: "Clínica Y", currency: "BRL" }]],
        [agentRuns, []],
      ]),
    );
    const res = await listAccountsData(db, ORG);
    expect(res).toEqual({
      accounts: [{ accountName: "Clínica Y", currency: "BRL", hasData: false, grade: null, headline: null, asOf: "sem dados" }],
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
    const res = await comparePeriodsData(db, ACCOUNT, ORG, 7, "America/Sao_Paulo", now);
    expect(res.current).toBe(100);
    expect(res.previous).toBe(50);
    expect(res.deltaPct).toBe(100);
  });
});

describe("renderWhatsappNumber (verbatim, honesto)", () => {
  it("meta_cta → afirma com confiança", () => {
    const t = renderWhatsappNumber({ number: "5531953491166", source: "meta_cta" }, "1398 CAPTACAO");
    expect(t).toContain("5531953491166");
    expect(t).toContain("1398 CAPTACAO");
    expect(t.toLowerCase()).not.toContain("confirma");
  });
  it("campaign_name → pede confirmação (não é autoritativo)", () => {
    const t = renderWhatsappNumber({ number: "953491166", source: "campaign_name", entityName: "X" }, "X");
    expect(t).toContain("953491166");
    expect(t.toLowerCase()).toContain("confirma");
    expect(t.toLowerCase()).toContain("nome");
  });
  it("none → diz que não achou + próximo passo, sem número", () => {
    const t = renderWhatsappNumber({ number: null, source: "none" }, "Y");
    expect(t.toLowerCase()).toContain("não achei");
    expect(t.toLowerCase()).toContain("gerenciador");
  });
});

describe("resolveWhatsappNumber (fallback ao vivo bounded — incidente do grupo)", () => {
  const ctx = { orgId: "o1", agentId: "ag1", adAccountId: "acc1" } as never;
  const account = [{ metaAdAccountId: "act_1", name: "X", currency: "BRL", accountToken: "tok", connToken: null }];

  function deps(getWhatsappDestination: () => Promise<unknown>) {
    return {
      db: fakeDb(new Map<unknown, unknown[]>([[adAccounts, account], [adCreatives, []]])),
      ports: { ads: { getWhatsappDestination: vi.fn(getWhatsappDestination) }, vault: { decrypt: (t: string) => t } },
      conversation: { liveFetchTimeoutMs: 1000 },
    } as never;
  }

  it("sem cache + Meta LANÇANDO → degrada p/ none (NÃO propaga → não derruba o turno)", async () => {
    const d = deps(() => Promise.reject(new Error("Meta 500")));
    const dest = await resolveWhatsappNumber(d, ctx, "CMP_1");
    expect(dest).toEqual({ number: null, source: "none" });
  });

  it("sem cache + Meta TRAVANDO além do teto → degrada p/ none (não pendura o turno)", async () => {
    const d = deps(() => new Promise(() => {})); // nunca resolve
    const dest = await resolveWhatsappNumber(d, ctx, "CMP_1");
    expect(dest).toEqual({ number: null, source: "none" });
  });

  it("sem cache + Meta OK → devolve o número vivo", async () => {
    const d = deps(() => Promise.resolve({ number: "5531999", source: "meta_cta" }));
    const dest = await resolveWhatsappNumber(d, ctx, "CMP_1");
    expect(dest).toEqual({ number: "5531999", source: "meta_cta" });
  });

  it("SEM conta em foco (adAccountId vazio — grupo com foco expirado) → none, sem crash de uuid", async () => {
    // loadAccount guarda uuid vazio (senão o Postgres lança 22P02 e derruba o turno).
    const noAccountCtx = { orgId: "o1", agentId: "ag1", adAccountId: "" } as never;
    const d = deps(() => Promise.reject(new Error("não deveria nem chamar a Meta")));
    const dest = await resolveWhatsappNumber(d, noAccountCtx, "CMP_1");
    expect(dest).toEqual({ number: null, source: "none" });
  });
});
