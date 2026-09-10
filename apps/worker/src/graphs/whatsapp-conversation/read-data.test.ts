import { describe, expect, it, vi } from "vitest";
import { adAccounts, adCreatives, agentMemory, agentRuns, agents, campaignDrafts, creativeAssets, creativeVisionAnalyses, entityAnalyses, insightsSnapshots, recommendations } from "@trafego/db";
import { libraryCreativeContentHash } from "../../workers/creative-analyze.js";
import type { Approval, ApprovalPort } from "@trafego/shared/ports";
import { AdsPlatformError } from "@trafego/shared/ports";
import type { PerformanceTier } from "@trafego/shared";
import {
  comparePeriodsData,
  getAccountStatusData,
  getAccountHealthData,
  getCampaignAnalysisData,
  getMetricsData,
  listAccountsData,
  listCampaignsData,
  latestAnalysisAsOf,
  describeDraftAudience,
  describeDraftCreative,
  describeDraftDestino,
  listPendingData,
  getLearningsData,
  listRecommendationsData,
  enrichRecommendationsLiveStatus,
  campaignStatusData,
  liveCampaignsNotCached,
  describePartialRun,
  renderWhatsappNumber,
  resolveWhatsappNumber,
  pickAdIdsToRefresh,
  getTopCreativesData,
  recallCreativeData,
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

  it("explicit (mulheres 45+ BH) → DESCREVE o público real, NUNCA 'amplo' (fim do falso positivo)", () => {
    const txt = describeDraftAudience({ kind: "explicit", geo: [{ key: "1", name: "Belo Horizonte", kind: "city" }], ageMin: 45, genders: [2] });
    expect(txt).toContain("Belo Horizonte");
    expect(txt).toContain("45+ anos");
    expect(txt).toContain("mulheres");
    expect(txt.toLowerCase()).not.toContain("amplo");
    expect(txt.toLowerCase()).not.toContain("meta escolhe");
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

describe("describeDraftDestino (qual Página/WhatsApp o rascunho de conversas leva — §7)", () => {
  it("nome + número → nomeia a Página e o número", () => {
    const txt = describeDraftDestino({ pageId: "P1", name: "CaquiAI Oficial", whatsappNumber: "5531953491398" });
    expect(txt).toContain("CaquiAI Oficial");
    expect(txt).toContain("+5531953491398");
  });
  it("só nome → nomeia a Página e é honesto que o número confirma após criar", () => {
    const txt = describeDraftDestino({ pageId: "P1", name: "CaquiAI Oficial" });
    expect(txt).toContain("CaquiAI Oficial");
    expect(txt.toLowerCase()).toContain("confirmo depois de criar");
  });
  it("degradado (só pageId) → descreve por PROVENIÊNCIA, nunca 'sem Página', e afirma que dá pra criar", () => {
    const txt = describeDraftDestino({ pageId: "P1" });
    expect(txt.toLowerCase()).toContain("anúncio ativo");
    expect(txt.toLowerCase()).toContain("dá pra criar");
    expect(txt).not.toContain("P1"); // nunca vaza id cru (§13)
    expect(txt.toLowerCase()).not.toContain("sem página");
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

  it("run PARCIAL por 'entities' (rate-limit da Meta) → partialNote grave", async () => {
    const finishedAt2 = new Date("2026-08-20T10:00:00.000Z");
    const db = fakeDb(
      new Map<unknown, unknown[]>([
        [
          agentRuns,
          [
            {
              id: "run-1",
              summary: "conta saudável",
              metricsSnapshot: { kpis: { spend: 100 }, scorecard: { grade: "B", headline: "vai bem" } },
              createdAt: new Date("2026-08-20T09:00:00.000Z"),
              finishedAt: finishedAt2,
              partial: true,
              partialReasons: ["entities"],
            },
          ],
        ],
        [recommendations, []],
      ]),
    );
    const res = await getAccountStatusData(db, AGENT, ORG, fakeApprovals([]));
    expect((res as { partialNote?: string }).partialNote).toContain("INCOMPLETA");
  });

  it("run partial:false → sem partialNote (não polui a resposta íntegra)", async () => {
    const finishedAt3 = new Date("2026-08-20T10:00:00.000Z");
    const db = fakeDb(
      new Map<unknown, unknown[]>([
        [agentRuns, [{ id: "run-1", summary: "s", metricsSnapshot: null, createdAt: finishedAt3, finishedAt: finishedAt3, partial: false, partialReasons: [] }]],
        [recommendations, []],
      ]),
    );
    const res = await getAccountStatusData(db, AGENT, ORG, fakeApprovals([]));
    expect((res as { partialNote?: string }).partialNote).toBeUndefined();
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

describe("latestAnalysisAsOf (frescor do dado curado p/ injetar no prompt)", () => {
  it("com run → finishedAt (a data que o chat cita ao responder 'de quando é')", async () => {
    const finishedAt = new Date("2026-09-07T22:02:00.000Z");
    const db = fakeDb(
      new Map<unknown, unknown[]>([
        [agentRuns, [{ id: "run-1", summary: null, metricsSnapshot: null, createdAt: new Date("2026-09-07T22:00:00.000Z"), finishedAt }]],
      ]),
    );
    expect(await latestAnalysisAsOf(db, AGENT, ORG)).toEqual(finishedAt);
  });

  it("run sem finishedAt → cai no createdAt (mesma regra do asOf das tools)", async () => {
    const createdAt = new Date("2026-09-07T22:00:00.000Z");
    const db = fakeDb(new Map<unknown, unknown[]>([[agentRuns, [{ id: "run-1", summary: null, metricsSnapshot: null, createdAt, finishedAt: null }]]]));
    expect(await latestAnalysisAsOf(db, AGENT, ORG)).toEqual(createdAt);
  });

  it("sem análise concluída → null (linha de frescor some)", async () => {
    const db = fakeDb(new Map<unknown, unknown[]>([[agentRuns, []]]));
    expect(await latestAnalysisAsOf(db, AGENT, ORG)).toBeNull();
  });
});

describe("getAccountHealthData (S5 — saúde da conta Meta no chat)", () => {
  it("token inválido → tokenExpired true, sem depender de status persistido", async () => {
    const db = fakeDb(new Map<unknown, unknown[]>([[adAccounts, [{ tokenStatus: "invalid", metaAccountStatus: null, metaSpendCap: null, metaHealthCheckedAt: null }]]]));
    const res = await getAccountHealthData(db, "acc-1", ORG);
    expect(res).toMatchObject({ hasData: true, tokenExpired: true });
  });

  it("conta ativa e saudável → status active + rótulo amigável + saldo/gasto expostos (opção a)", async () => {
    const checkedAt = new Date("2026-09-01T10:00:00.000Z");
    const db = fakeDb(
      new Map<unknown, unknown[]>([
        [
          adAccounts,
          [
            {
              tokenStatus: "valid",
              metaAccountStatus: "active",
              currency: "BRL",
              metaBalance: "42.5000",
              metaAmountSpent: "1000.0000",
              metaSpendCap: null,
              metaHealthCheckedAt: checkedAt,
            },
          ],
        ],
      ]),
    );
    const res = await getAccountHealthData(db, "acc-1", ORG);
    // saldo/gasto vêm no payload (dado do dono) — teto null = sem teto na Meta (nunca "0" enganoso).
    expect(res).toMatchObject({
      hasData: true,
      status: "active",
      tokenExpired: false,
      currency: "BRL",
      balanceMajor: 42.5,
      amountSpentMajor: 1000,
      spendCapMajor: null,
    });
    expect((res as { statusLabel: string }).statusLabel).toContain("ativa");
    expect((res as { checkedAt: string }).checkedAt).toBe(checkedAt.toISOString());
  });

  it("conta desativada → status disabled + rótulo do status + teto exposto como número", async () => {
    const db = fakeDb(new Map<unknown, unknown[]>([[adAccounts, [{ tokenStatus: "valid", metaAccountStatus: "disabled", metaSpendCap: "500.0000", metaHealthCheckedAt: new Date() }]]]));
    const res = await getAccountHealthData(db, "acc-1", ORG);
    expect(res).toMatchObject({ hasData: true, status: "disabled", spendCapMajor: 500 });
    expect((res as { statusLabel: string }).statusLabel).toBe("Conta desativada, parou de veicular anúncios");
  });

  it("conta ainda não checada (sync nunca rodou a saúde) → assume active, checkedAt null", async () => {
    const db = fakeDb(new Map<unknown, unknown[]>([[adAccounts, [{ tokenStatus: "valid", metaAccountStatus: null, metaSpendCap: null, metaHealthCheckedAt: null }]]]));
    const res = await getAccountHealthData(db, "acc-1", ORG);
    expect(res).toMatchObject({ hasData: true, status: "active", checkedAt: null });
  });

  it("conta não encontrada → hasData:false", async () => {
    const db = fakeDb(new Map<unknown, unknown[]>([[adAccounts, []]]));
    const res = await getAccountHealthData(db, "acc-x", ORG);
    expect(res).toMatchObject({ hasData: false });
  });

  it("erro de DB (ex: coluna nova ausente na janela de migration) → nota amigável, NUNCA vaza detalhe técnico (achado do E2E)", async () => {
    const throwingDb = {
      select: () => ({ from: () => ({ where: () => ({ limit: () => Promise.reject(new Error('column "meta_account_status" does not exist')) }) }) }),
    } as never;
    const res = await getAccountHealthData(throwingDb, "acc-1", ORG);
    expect(res).toMatchObject({ hasData: false });
    const note = (res as { note: string }).note;
    expect(note).not.toContain("meta_account_status"); // nome de coluna nunca vaza
    expect(note.toLowerCase()).toContain("não consegui");
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

describe("getTopCreativesData — lookup por nome/id (C3)", () => {
  const creativeRows = [
    { adId: "ad_1", name: "Criativo Verão", tier: "winner", spend: 500, cpa: 12, roas: 3, body: "texto verão", title: "Verão", callToAction: "SHOP_NOW" },
    { adId: "ad_2", name: "Criativo Inverno", tier: "performer", spend: 200, cpa: 20, roas: 1.5, body: "texto inverno", title: "Inverno", callToAction: "LEARN_MORE" },
  ];
  const depsWith = (rows: unknown[] = creativeRows) =>
    ({ db: fakeDb(new Map<unknown, unknown[]>([[adCreatives, rows]])), visionAnalyzerVersion: 1 }) as unknown as Parameters<typeof getTopCreativesData>[0];
  const CTX = { orgId: "org", adAccountId: "acc" } as unknown as Parameters<typeof getTopCreativesData>[1];

  it("SEM query → top-N ranqueado + campo escopo honesto", async () => {
    const res = await getTopCreativesData(depsWith(), CTX);
    expect(res).toMatchObject({ hasData: true });
    expect("creatives" in res && res.creatives.length).toBe(2);
    expect("escopo" in res && typeof res.escopo).toBe("string"); // §7: sempre repassa a limitação
  });

  it("query por nome → um criativo com a copy", async () => {
    const res = await getTopCreativesData(depsWith(), CTX, "verão");
    expect(res).toMatchObject({ hasData: true, match: "one", creative: { adId: "ad_1", copy: "texto verão", cta: "SHOP_NOW" } });
  });

  it("query por id → casa direto", async () => {
    const res = await getTopCreativesData(depsWith(), CTX, "ad_2");
    expect(res).toMatchObject({ match: "one", creative: { adId: "ad_2" } });
  });

  it("query inexistente → match none (não inventa)", async () => {
    const res = await getTopCreativesData(depsWith(), CTX, "não existe zzz");
    expect(res).toMatchObject({ match: "none" });
  });

  it("SEM anúncios capturados MAS com biblioteca → lista a biblioteca (Fatia 1, fix BM Automato)", async () => {
    const db = fakeDb(
      new Map<unknown, unknown[]>([
        [adCreatives, []],
        [creativeAssets, [{ id: "lib1", format: "image", visionContentHash: null }]],
        [creativeVisionAnalyses, []],
      ]),
    );
    const deps = { db, visionAnalyzerVersion: 1 } as unknown as Parameters<typeof getTopCreativesData>[0];
    const res = await getTopCreativesData(deps, CTX);
    expect(res).toMatchObject({ hasData: true });
    if (!("creatives" in res)) throw new Error("esperava lista");
    expect(res.creatives.length).toBe(1);
    expect(res.creatives[0]).toMatchObject({ origem: "biblioteca do site", id: "lib1" });
  });

  it("banco vazio → fallback AO VIVO inclui anúncios de campanha PAUSADA, rotulados (Fatia 2)", async () => {
    const account = [{ metaAdAccountId: "act_1", name: "X", currency: "BRL", accountToken: "tok", connToken: null }];
    const db = fakeDb(new Map<unknown, unknown[]>([[adCreatives, []], [adAccounts, account], [creativeAssets, []], [creativeVisionAnalyses, []]]));
    const ads = [
      { id: "ad_flop", level: "ad", name: "Fraco", status: "paused" },
      { id: "ad_win", level: "ad", name: "Anúncio Pausado", status: "paused" },
    ];
    const creatives = [
      { id: "cr1", adId: "ad_win", body: "texto do anúncio pausado", title: "Título", callToAction: "LEARN_MORE", adFormat: "image" },
      { id: "cr2", adId: "ad_flop", body: "texto fraco", adFormat: "image" },
    ];
    // ad_win tem resultado (melhor CPA) → deve vir ANTES do ad_flop (sem resultado) no ranking.
    const metrics = [
      { adId: "ad_win", spend: 100, results: 10 },
      { adId: "ad_flop", spend: 50, results: 0 },
    ];
    const deps = {
      db,
      visionAnalyzerVersion: 1,
      conversation: { liveFetchTimeoutMs: 1000 },
      ports: { ads: { listEntities: vi.fn(async () => ads), getCreatives: vi.fn(async () => creatives), getAdMetrics: vi.fn(async () => metrics) }, vault: { decrypt: (t: string) => t } },
    } as unknown as Parameters<typeof getTopCreativesData>[0];
    const res = await getTopCreativesData(deps, CTX);
    expect(res).toMatchObject({ hasData: true });
    if (!("creatives" in res)) throw new Error("esperava lista");
    // ranqueado por desempenho: o com resultado (ad_win) vem primeiro, com a métrica bruta anexada.
    expect(res.creatives[0]).toMatchObject({ origem: "pausado (ao vivo)", adId: "ad_win", copy: "texto do anúncio pausado", gastoHistorico: 100, resultados: 10, cpaHistorico: 10 });
    expect(res.creatives[1]).toMatchObject({ adId: "ad_flop" });
    expect("escopo" in res && res.escopo).toContain("AO VIVO");
  });

  it("banco vazio + query por NOME → acha AO VIVO um anúncio pausado (lookup estendido)", async () => {
    const account = [{ metaAdAccountId: "act_1", name: "X", currency: "BRL", accountToken: "tok", connToken: null }];
    const db = fakeDb(new Map<unknown, unknown[]>([[adCreatives, []], [adAccounts, account], [creativeAssets, []], [creativeVisionAnalyses, []]]));
    const ads = [{ id: "ad_p", level: "ad", name: "Campeão do Verão", status: "paused" }];
    const creatives = [{ id: "cr", adId: "ad_p", body: "copy do campeão", adFormat: "image" }];
    const deps = {
      db,
      visionAnalyzerVersion: 1,
      conversation: { liveFetchTimeoutMs: 1000 },
      ports: { ads: { listEntities: vi.fn(async () => ads), getCreatives: vi.fn(async () => creatives) }, vault: { decrypt: (t: string) => t } },
    } as unknown as Parameters<typeof getTopCreativesData>[0];
    const res = await getTopCreativesData(deps, CTX, "campeão");
    expect(res).toMatchObject({ match: "one", creative: { adId: "ad_p", status: "paused", copy: "copy do campeão" } });
  });
});

describe("recallCreativeData (Slice 3 — busca as DUAS chaves de visão: chat + biblioteca)", () => {
  const VISION = {
    summary: "vídeo da praia ao pôr do sol",
    hook: "abre no mar",
    angle: "lifestyle",
    format: "ugc",
    body: "b",
    cta: "c",
    proofStrength: "medium",
    persuasionSignals: 2,
    strengths: ["s"],
    weaknesses: ["w"],
    score: 7,
  };
  const makeDeps = (db: unknown) =>
    ({ db, visionAnalyzerVersion: 1, ports: { llm: { completeStructured: vi.fn() } }, analysis: { messageModel: "m" } }) as unknown as Parameters<typeof recallCreativeData>[0];
  const CTX = { orgId: "org", adAccountId: "acc" } as unknown as Parameters<typeof recallCreativeData>[1];

  it("análise SÓ sob libraryCreativeContentHash (chat degradou) → recall ainda acha (não falso-negativo)", async () => {
    // o vídeo tem vision_content_hash (bytes) setado no ingest, mas a análise de CHAT degradou → só
    // existe a linha sob a chave da BIBLIOTECA (frames Meta). O recall precisa achar mesmo assim.
    const asset = { id: "asset-vid-1", format: "video", visionContentHash: "HASH_CHAT_SEM_ANALISE" };
    const visionRow = { contentHash: libraryCreativeContentHash("asset-vid-1"), result: VISION };
    const db = fakeDb(new Map<unknown, unknown[]>([[creativeAssets, [asset]], [creativeVisionAnalyses, [visionRow]]]));
    const res = await recallCreativeData(makeDeps(db), CTX, null);
    expect(res).toMatchObject({ hasData: true, creative: { summary: VISION.summary } });
  });

  it("nenhuma análise em nenhuma das chaves → match none honesto (não inventa)", async () => {
    const asset = { id: "asset-vid-2", format: "video", visionContentHash: "HASH_SEM_ANALISE" };
    const db = fakeDb(new Map<unknown, unknown[]>([[creativeAssets, [asset]], [creativeVisionAnalyses, []]]));
    const res = await recallCreativeData(makeDeps(db), CTX, null);
    expect(res).toMatchObject({ hasData: true, match: "none" });
  });
});

describe("getCampaignAnalysisData", () => {
  const rows = [
    {
      entityLevel: "campaign" as const,
      entityName: "Lançamento Black Friday",
      unitJson: { summary: "escala bem", findings: [{ title: "CTR caindo", severity: "warning" }], flags: [] },
      metricsJson: { spend: 500, cpa: 12, roas: 3 },
      flags: ["scaling"],
      analyzedAt: new Date("2026-08-20T08:00:00.000Z"),
    },
    {
      entityLevel: "campaign" as const,
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
      // S1: linha sem curatedJson (de antes da fase) → campos de orçamento null, não omitidos.
      tier: null,
      budget: null,
      atBudgetCeiling: null,
      isCBO: null,
      deactivatedSince: null,
      asOf: "2026-08-20T08:00:00.000Z",
    });
  });

  it("S1: com curatedJson → expõe tier/budget/atBudgetCeiling/isCBO (fecha o bug do orçamento no chat)", async () => {
    const withCurated = [
      {
        ...rows[0],
        curatedJson: { isCBO: true, tier: "winner", budget: { dailyMajor: 150 }, atBudgetCeiling: true },
      },
    ];
    const db = fakeDb(new Map<unknown, unknown[]>([[entityAnalyses, withCurated]]));
    const res = await getCampaignAnalysisData(db, AGENT, "black friday");
    expect(res).toMatchObject({ tier: "winner", budget: { dailyMajor: 150 }, atBudgetCeiling: true, isCBO: true });
  });

  it("sincronização: curatedJson.deactivatedSince presente → propaga no cartão (chat sabe que não é mais atual)", async () => {
    const withDeactivated = [{ ...rows[0], curatedJson: { isCBO: true, tier: "winner", deactivatedSince: "2026-08-25T00:00:00.000Z" } }];
    const db = fakeDb(new Map<unknown, unknown[]>([[entityAnalyses, withDeactivated]]));
    const res = await getCampaignAnalysisData(db, AGENT, "black friday");
    expect(res).toMatchObject({ deactivatedSince: "2026-08-25T00:00:00.000Z" });
  });

  it("S8/S8b: campanha ABO (isCBO=false) com 2+ conjuntos com diagnóstico próprio → expõe adsets + adsetsNote (assimetria CBO×ABO rotulada)", async () => {
    const withAdsets = [
      { ...rows[0], entityId: "c1", curatedJson: { isCBO: false, tier: "performer" } },
      { entityLevel: "adset" as const, entityId: "as1", entityName: "Conjunto quente", unitJson: {}, metricsJson: {}, flags: [], curatedJson: { isCBO: true, tier: "winner", campaignId: "c1" }, analyzedAt: new Date("2026-08-20T08:00:00.000Z") },
      { entityLevel: "adset" as const, entityId: "as2", entityName: "Conjunto frio", unitJson: {}, metricsJson: {}, flags: [], curatedJson: { isCBO: true, tier: "zombie", campaignId: "c1" }, analyzedAt: new Date("2026-08-20T08:00:00.000Z") },
      // adset de OUTRA campanha — não pode vazar pro breakdown de c1.
      { entityLevel: "adset" as const, entityId: "as3", entityName: "Conjunto de outra campanha", unitJson: {}, metricsJson: {}, flags: [], curatedJson: { isCBO: true, tier: "performer", campaignId: "c-outra" }, analyzedAt: new Date("2026-08-20T08:00:00.000Z") },
    ];
    const db = fakeDb(new Map<unknown, unknown[]>([[entityAnalyses, withAdsets]]));
    const res = await getCampaignAnalysisData(db, AGENT, "black friday");
    expect(res).toMatchObject({
      isCBO: false,
      adsets: expect.arrayContaining([
        { id: "as1", name: "Conjunto quente", tier: "winner" },
        { id: "as2", name: "Conjunto frio", tier: "zombie" },
      ]),
    });
    const withAdsetsRes = res as unknown as { adsets: unknown[]; adsetsNote: string };
    expect(withAdsetsRes.adsets).toHaveLength(2); // não inclui as3 (outra campanha)
    expect(withAdsetsRes.adsetsNote).toMatch(/ABO|orçamento por conjunto/i);
  });

  it("campanha CBO (isCBO=true) → NUNCA expõe adsets, mesmo com conjuntos na tabela", async () => {
    const cboWithAdsets = [
      { ...rows[0], entityId: "c1", curatedJson: { isCBO: true, tier: "winner" } },
      { entityLevel: "adset" as const, entityId: "as1", entityName: "Conjunto", unitJson: {}, metricsJson: {}, flags: [], curatedJson: { isCBO: false, campaignId: "c1" }, analyzedAt: new Date("2026-08-20T08:00:00.000Z") },
    ];
    const db = fakeDb(new Map<unknown, unknown[]>([[entityAnalyses, cboWithAdsets]]));
    const res = await getCampaignAnalysisData(db, AGENT, "black friday");
    expect((res as { adsets?: unknown[] }).adsets).toBeUndefined();
  });

  it("achado da revisão (Fase 3) — adset com nome PARECIDO ao de uma campanha nunca entra no matcher de campanha", async () => {
    const withLookalikeAdset = [
      { ...rows[0], entityId: "c1" }, // campanha "Lançamento Black Friday"
      // nome do adset CONTÉM o texto buscado — não pode ser confundido com campanha nem gerar ambiguidade.
      { entityLevel: "adset" as const, entityId: "as1", entityName: "Lançamento Black Friday — Conjunto 1", unitJson: {}, metricsJson: {}, flags: [], curatedJson: {}, analyzedAt: new Date("2026-08-20T08:00:00.000Z") },
    ];
    const db = fakeDb(new Map<unknown, unknown[]>([[entityAnalyses, withLookalikeAdset]]));
    const res = await getCampaignAnalysisData(db, AGENT, "black friday");
    expect(res).toMatchObject({ id: "c1", name: "Lançamento Black Friday" }); // achou a campanha, sem ambiguidade
  });

  it("achado da revisão (Fase 3) — adset LEGADO (curatedJson sem campaignId, de antes do S8) some do breakdown sem erro", async () => {
    const legacyAdset = [
      { ...rows[0], entityId: "c1", curatedJson: { isCBO: false, tier: "performer" } },
      // 2 adsets qualificariam o breakdown, mas nenhum tem campaignId (linha persistida antes do S8).
      { entityLevel: "adset" as const, entityId: "as1", entityName: "Conjunto legado 1", unitJson: {}, metricsJson: {}, flags: [], curatedJson: { isCBO: true, tier: "winner" }, analyzedAt: new Date("2026-08-20T08:00:00.000Z") },
      { entityLevel: "adset" as const, entityId: "as2", entityName: "Conjunto legado 2", unitJson: {}, metricsJson: {}, flags: [], curatedJson: { isCBO: true, tier: "zombie" }, analyzedAt: new Date("2026-08-20T08:00:00.000Z") },
    ];
    const db = fakeDb(new Map<unknown, unknown[]>([[entityAnalyses, legacyAdset]]));
    const res = await getCampaignAnalysisData(db, AGENT, "black friday");
    expect((res as { adsets?: unknown[] }).adsets).toBeUndefined(); // degrada com honestidade, não quebra
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
    const r = res as unknown as { hasData: true; campaigns: Array<Record<string, unknown>> };
    expect(r.campaigns.map((c) => c.id)).toEqual(["c-big", "c-small"]); // gasto 500 > 100; c-big só 1x
    expect(r.campaigns[0]).toMatchObject({ name: "Prospecção", spend: 500, conversions: 40, cpa: 12.5, tier: "underperformer" });
    expect(r.campaigns[1]).toMatchObject({ name: "Remarketing", spend: 100, roas: 4, revenue: 400 });
  });

  it("nenhuma campanha analisada → hasData:false", async () => {
    const db = fakeDb(new Map<unknown, unknown[]>([[entityAnalyses, []]]));
    const res = await listCampaignsData(db, AGENT);
    expect(res).toMatchObject({ hasData: false });
  });

  it("S1: expõe budget/atBudgetCeiling/isCBO por campanha (curatedJson)", async () => {
    const withCurated = [{ ...rows[1], curatedJson: { isCBO: false, tier: "underperformer" } }];
    const db = fakeDb(new Map<unknown, unknown[]>([[entityAnalyses, withCurated]]));
    const res = await listCampaignsData(db, AGENT);
    const r = res as unknown as { hasData: true; campaigns: Array<Record<string, unknown>> };
    expect(r.campaigns[0]).toMatchObject({ isCBO: false, budget: null, atBudgetCeiling: null });
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
    expect(res).toMatchObject({ hasData: true, recommendations: [{ title: "Pausar ad X", rationale: "sem venda", riskLevel: "low" }] });
    expect((res as { asOf: string }).asOf).toBeTypeOf("string");
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
      { kind: "activation", id: "ap-act-1", entityName: null, reason: expect.stringContaining("ativar"), expiresAt: "2026-08-21T00:00:00.000Z" },
    ]);
  });

  it("ativação NOMEADA: rascunho com campaignName → entityName + reason cita o nome (ativar por referência)", async () => {
    const activationApproval = {
      id: "ap-act-2",
      kind: "activation",
      orgId: ORG,
      agentId: AGENT,
      runId: null,
      contactId: null,
      status: "pending",
      draftId: "draft-2",
      resolvedReason: null,
      expiresAt: new Date("2026-08-21T00:00:00.000Z"),
      createdAt: new Date("2026-08-20T00:00:00.000Z"),
    };
    const draftRow = {
      id: "draft-2",
      kind: "from_scratch",
      spec: { version: 1, currency: "BRL", dailyBudgetMinor: 5000, activation: "paused", objective: "messaging_started", campaignName: "CaquiAI - conversa" },
    };
    const db = fakeDb(new Map([[campaignDrafts, [draftRow]]]));
    const [item] = (await listPendingData(db, fakeApprovals([activationApproval as unknown as Approval]), ORG)) as Array<{ kind: string; entityName: string | null; reason: string }>;
    expect(item?.kind).toBe("activation");
    expect(item?.entityName).toBe("CaquiAI - conversa");
    expect(item?.reason).toContain("CaquiAI - conversa");
    expect(item?.reason).toContain("ativar");
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

describe("campaignStatusData (ambíguo → LISTA com status ao vivo, NÃO pede id)", () => {
  const ctx = { orgId: "o1", agentId: "ag1", adAccountId: "acc1" } as never;
  const account = [{ metaAdAccountId: "act_1", name: "X", currency: "BRL", accountToken: "tok", connToken: null }];
  function deps(listEntities: () => Promise<unknown>, readEntityState: (ref: unknown, id: string) => Promise<unknown>, readActivationTree?: (ref: unknown, level: string, id: string) => Promise<unknown>) {
    return {
      db: fakeDb(new Map<unknown, unknown[]>([[adAccounts, account]])),
      ports: { ads: { listEntities: vi.fn(listEntities), readEntityState: vi.fn(readEntityState), ...(readActivationTree ? { readActivationTree: vi.fn(readActivationTree) } : {}) }, vault: { decrypt: (t: string) => t } },
      conversation: { liveFetchTimeoutMs: 1000 },
    } as never;
  }

  it("nome ambíguo → devolve TODAS as campanhas que casaram, com status ao vivo de cada", async () => {
    const cats = [{ id: "c1", name: "TESTE - Melhores numeros" }, { id: "c2", name: "TESTE Initiate Checkout" }];
    const st: Record<string, string> = { c1: "ACTIVE", c2: "PAUSED" };
    const d = deps(async () => cats, async (_ref, id) => ({ status: st[id] }));
    const out = await campaignStatusData(d, ctx, { name: "TESTE" });
    expect(out).toMatchObject({ hasData: true });
    const c = (out as { campaigns: { id: string; status: string }[] }).campaigns;
    expect(c.length).toBe(2);
    expect(c.map((x) => x.status).sort()).toEqual(["active", "paused"]);
  });

  it("id explícito → 1 campanha com status ao vivo", async () => {
    const d = deps(async () => [], async () => ({ status: "ACTIVE" }));
    const out = await campaignStatusData(d, ctx, { campaignId: "c9" });
    expect(out).toMatchObject({ hasData: true, campaigns: [{ id: "c9", status: "active" }] });
  });

  it("nome sem match → hasData:false (não achei)", async () => {
    const d = deps(async () => [{ id: "c1", name: "Outra campanha" }], async () => ({ status: "ACTIVE" }));
    const out = await campaignStatusData(d, ctx, { name: "ZZZ inexistente" });
    expect(out).toMatchObject({ hasData: false });
  });

  it("ENTREGA EFETIVA: campanha ATIVA mas sem anúncio ativo → delivering:false + motivo", async () => {
    const tree = { adsets: [{ id: "s1", name: "s1", status: "active", effectiveStatus: "active" }], ads: [{ id: "a1", name: "a1", status: "paused", effectiveStatus: "paused", adsetId: "s1" }], truncated: false };
    const d = deps(async () => [], async () => ({ status: "ACTIVE" }), async () => tree);
    const out = await campaignStatusData(d, ctx, { campaignId: "c9" });
    expect(out).toMatchObject({ hasData: true, campaigns: [{ id: "c9", status: "active", delivering: false, deliveryReason: "anúncios pausados" }] });
  });

  it("ENTREGA EFETIVA: campanha PAUSADA → delivering:false 'campanha pausada' (sem ler a árvore)", async () => {
    const readTree = vi.fn(async () => ({ adsets: [], ads: [], truncated: false }));
    const d = deps(async () => [], async () => ({ status: "PAUSED" }), readTree);
    const out = await campaignStatusData(d, ctx, { campaignId: "c9" });
    expect(out).toMatchObject({ hasData: true, campaigns: [{ id: "c9", status: "paused", delivering: false, deliveryReason: "campanha pausada" }] });
    expect(readTree).not.toHaveBeenCalled();
  });

  it("ENTREGA EFETIVA: campanha ATIVA com anúncio efetivamente ativo → delivering:true", async () => {
    const tree = { adsets: [{ id: "s1", name: "s1", status: "active", effectiveStatus: "active" }], ads: [{ id: "a1", name: "a1", status: "active", effectiveStatus: "active", adsetId: "s1" }], truncated: false };
    const d = deps(async () => [], async () => ({ status: "ACTIVE" }), async () => tree);
    const out = await campaignStatusData(d, ctx, { campaignId: "c9" });
    expect(out).toMatchObject({ hasData: true, campaigns: [{ id: "c9", delivering: true }] });
  });

  it("token inválido (190) na leitura → note 'reconecte' (não 'tenta de novo')", async () => {
    const d = deps(async () => [], async () => {
      throw new AdsPlatformError("invalid_credential", "token expirado");
    });
    const out = await campaignStatusData(d, ctx, { campaignId: "c9" });
    expect(out).toMatchObject({ hasData: false });
    expect((out as { note: string }).note).toContain("reconecte");
  });

  it("erro transiente na leitura → note 'tenta de novo' (não token)", async () => {
    const d = deps(async () => [], async () => {
      throw new Error("upstream");
    });
    const out = await campaignStatusData(d, ctx, { campaignId: "c9" });
    expect(out).toMatchObject({ hasData: false });
    expect((out as { note: string }).note).toContain("tenta de novo");
  });
});

describe("describePartialRun (honestidade sobre completude — achado do run parcial real)", () => {
  it("sem motivos → íntegra, null", () => {
    expect(describePartialRun([])).toBeNull();
  });

  it("'entities' (rate-limit no meio da paginação) → aviso GRAVE de dado incompleto", () => {
    expect(describePartialRun(["entities"])).toContain("INCOMPLETA");
  });

  it("'metrics' → mesmo aviso grave (sync de insights degradou)", () => {
    expect(describePartialRun(["metrics"])).toContain("INCOMPLETA");
  });

  it("só 'campaign_analysis'/'review'/'creative_vision' → aviso mais brando (enriquecimento, não o dado em si)", () => {
    const msg = describePartialRun(["review"]);
    expect(msg).not.toContain("INCOMPLETA");
    expect(msg).toContain("enriquecimento");
  });

  it("'action_apply' sozinho → aviso específico de escrita, análise íntegra", () => {
    expect(describePartialRun(["action_apply"])).toContain("falhou ao aplicar");
  });

  it("misto grave + enriquecimento → prioriza o aviso grave", () => {
    expect(describePartialRun(["review", "entities"])).toContain("INCOMPLETA");
  });
});

describe("liveCampaignsNotCached (gap de sincronização — pivô saúde)", () => {
  const ctx = { orgId: "o1", agentId: "ag1", adAccountId: "acc1" } as never;
  const account = [{ metaAdAccountId: "act_1", name: "X", currency: "BRL", accountToken: "tok", connToken: null }];
  function deps(listEntities: () => Promise<unknown>) {
    return {
      db: fakeDb(new Map<unknown, unknown[]>([[adAccounts, account]])),
      ports: { ads: { listEntities: vi.fn(listEntities) }, vault: { decrypt: (t: string) => t } },
      conversation: { liveFetchTimeoutMs: 1000 },
    } as never;
  }

  it("campanha GERENCIÁVEL (ativa OU pausada) fora do cache → aparece com o status; pausada incluída", async () => {
    const d = deps(async () => [
      { id: "c1", name: "Já cacheada", status: "active" },
      { id: "c2", name: "Campanha nova", status: "active" },
      { id: "c3", name: "Pausada, nunca cacheada", status: "paused" },
    ]);
    const gaps = await liveCampaignsNotCached(d, ctx, new Set(["c1"]));
    expect(gaps).toEqual([
      { id: "c2", name: "Campanha nova", status: "active" },
      { id: "c3", name: "Pausada, nunca cacheada", status: "paused" },
    ]);
  });

  it("archived/deleted (terminais) NÃO entram — só gerenciáveis", async () => {
    const d = deps(async () => [
      { id: "c2", name: "Ativa", status: "active" },
      { id: "c4", name: "Arquivada", status: "archived" },
      { id: "c5", name: "Deletada", status: "deleted" },
    ]);
    expect(await liveCampaignsNotCached(d, ctx, new Set())).toEqual([{ id: "c2", name: "Ativa", status: "active" }]);
  });

  it("nada de novo (tudo já cacheado) → lista vazia", async () => {
    const d = deps(async () => [{ id: "c1", name: "Já cacheada", status: "active" }]);
    expect(await liveCampaignsNotCached(d, ctx, new Set(["c1"]))).toEqual([]);
  });

  it("Meta indisponível/lenta → degrada em lista vazia (best-effort, não derruba o turno)", async () => {
    const d = deps(async () => {
      throw new Error("timeout");
    });
    expect(await liveCampaignsNotCached(d, ctx, new Set())).toEqual([]);
  });

  it("conta não encontrada → lista vazia", async () => {
    const d = { db: fakeDb(new Map()), ports: { ads: { listEntities: vi.fn() }, vault: { decrypt: (t: string) => t } }, conversation: { liveFetchTimeoutMs: 1000 } } as never;
    expect(await liveCampaignsNotCached(d, ctx, new Set())).toEqual([]);
  });
});

describe("enrichRecommendationsLiveStatus (re-check DETERMINÍSTICO de status — incidente Dani)", () => {
  const ctx = { orgId: "o1", agentId: "ag1", adAccountId: "acc1" } as never;
  const account = [{ metaAdAccountId: "act_1", name: "X", currency: "BRL", accountToken: "tok", connToken: null }];
  const base = (recs: unknown[]) => ({ hasData: true as const, asOf: "2026-08-31T05:00:00Z", recommendations: recs as never });
  function deps(listEntities: () => Promise<unknown>, readEntityState: () => Promise<unknown>) {
    return {
      db: fakeDb(new Map<unknown, unknown[]>([[adAccounts, account]])),
      ports: { ads: { listEntities: vi.fn(listEntities), readEntityState: vi.fn(readEntityState) }, vault: { decrypt: (t: string) => t } },
      conversation: { liveFetchTimeoutMs: 1000 },
    } as never;
  }

  it("'Reativar X' (id citado no rationale) + campanha ATIVA ao vivo → anexa liveStatus.status='active'", async () => {
    const d = deps(
      async () => [{ id: "52637228752692", name: "TESTE - Melhores numeros" }],
      async () => ({ status: "ACTIVE", effective_status: "ACTIVE" }),
    );
    const out = await enrichRecommendationsLiveStatus(d, ctx, base([{ title: "Reativar TESTE Melhores numeros", rationale: "A campanha 52637228752692 gerou 93 conversas a CPL R$5,69, hoje pausada.", riskLevel: "low" }]));
    expect(out.recommendations[0]!.liveStatus).toMatchObject({ campaignId: "52637228752692", status: "active" });
  });

  it("resolve por ALVO estruturado (platform_action) quando presente", async () => {
    const d = deps(async () => [{ id: "c1", name: "Escala" }], async () => ({ status: "PAUSED" }));
    const out = await enrichRecommendationsLiveStatus(d, ctx, base([{ title: "Retomar a Escala", rationale: "parou", riskLevel: "medium", proposedAction: { type: "resume_entity", target: { level: "campaign", id: "c1" } } }]));
    expect(out.recommendations[0]!.liveStatus).toMatchObject({ campaignId: "c1", status: "paused" });
  });

  it("rec NÃO dependente de status → sem liveStatus (não gasta leitura)", async () => {
    const d = deps(async () => [{ id: "c1", name: "TESTE" }], async () => ({ status: "ACTIVE" }));
    const out = await enrichRecommendationsLiveStatus(d, ctx, base([{ title: "Revisar criativo do TESTE", rationale: "CTR caindo", riskLevel: "low" }]));
    expect(out.recommendations[0]!.liveStatus).toBeUndefined();
  });

  it("Meta LANÇANDO no status → degrada (sem liveStatus, não quebra)", async () => {
    const d = deps(async () => [{ id: "52637228752692", name: "TESTE" }], () => Promise.reject(new Error("meta 500")));
    const out = await enrichRecommendationsLiveStatus(d, ctx, base([{ title: "Reativar TESTE", rationale: "campanha 52637228752692", riskLevel: "low" }]));
    expect(out.recommendations[0]!.liveStatus).toBeUndefined();
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

describe("getLearningsData — expõe o id que as tools de controle consomem (regressão)", () => {
  it("cada aprendizado traz id + tier + origem + hasProposal (sem id o LLM não consegue agir)", async () => {
    const db = fakeDb(
      new Map([
        [
          agentMemory,
          [
            {
              id: "lesson-uuid-1",
              content: "Nesta conta, cortar desperdício cedo tende a compensar.",
              confidence: 0.82,
              origin: "our_action",
              confirmedByHuman: false,
              proposedThresholdPatch: { threshold: "zombieMinSpend", stepPct: 0.25, minValue: 1 },
            },
            {
              id: "lesson-uuid-2",
              content: "A medição de conversão aparece suspeita.",
              confidence: 0.3,
              origin: "observational",
              confirmedByHuman: false,
              proposedThresholdPatch: null,
            },
          ],
        ],
      ]),
    );
    const out = await getLearningsData(db, "o1", "ag1");
    expect(out.hasData).toBe(true);
    const learnings = (out as { learnings: Array<Record<string, unknown>> }).learnings;
    // o id é a referência inequívoca p/ confirm/forget/approve/reject (senão a ação por chat falha).
    expect(learnings[0]?.id).toBe("lesson-uuid-1");
    expect(learnings[0]?.hasProposal).toBe(true);
    expect(learnings[0]?.confidence).toBe("provavel");
    expect(learnings[1]?.id).toBe("lesson-uuid-2");
    expect(learnings[1]?.hasProposal).toBe(false);
  });

  it("sem aprendizados → hasData=false com nota honesta", async () => {
    const db = fakeDb(new Map([[agentMemory, []]]));
    const out = await getLearningsData(db, "o1", "ag1");
    expect(out.hasData).toBe(false);
  });
});
