import { describe, expect, it } from "vitest";
import type { AdEntity, InsightMetrics, InsightRow } from "@trafego/shared";
import { buildAccountBrief, type BuildAccountBriefInput } from "./index.js";

// helper: linha de insight (normalize só lê spend/impressions/clicks + conversions)
function row(
  entityId: string,
  level: InsightRow["level"],
  spend: number,
  impressions: number,
  clicks: number,
  purchases?: { count: number; value?: number },
): InsightRow {
  const metrics: InsightMetrics = { spend, impressions, clicks, ctr: 0, cpc: 0, cpm: 0 };
  return {
    entityId,
    level,
    date: "2026-08-10",
    metrics,
    ...(purchases
      ? { conversions: [{ goal: "purchase", count: purchases.count, ...(purchases.value ? { value: purchases.value } : {}) }] }
      : {}),
  };
}

const entities: AdEntity[] = [
  { id: "c1", level: "campaign", name: "Lançamento A", status: "active", objective: { goal: "purchase" } },
  { id: "c2", level: "campaign", name: "Lançamento B", status: "active", objective: { goal: "purchase" } },
];

function baseInput(overrides: Partial<BuildAccountBriefInput> = {}): BuildAccountBriefInput {
  return {
    account: { id: "act_1", name: "Conta Teste", currency: "BRL" },
    window: "últimos 7 dias",
    baselineWindow: "7 dias anteriores",
    goals: { targetCPA: 50 },
    entities,
    rows: [
      row("act_1", "account", 300, 10000, 200, { count: 5, value: 1500 }),
      row("c1", "campaign", 100, 4000, 80, { count: 4, value: 1200 }), // CPA 25 (bom)
      row("c2", "campaign", 200, 6000, 120, { count: 2, value: 300 }), // CPA 100 (acima da meta 50)
    ],
    baselineRows: [
      row("c1", "campaign", 90, 3800, 70, { count: 3, value: 900 }),
      row("c2", "campaign", 180, 5800, 110, { count: 3, value: 450 }),
    ],
    playbookCandidates: [],
    topN: 10,
    notableAdsPerCampaign: 5,
    ...overrides,
  };
}

describe("buildAccountBrief", () => {
  it("monta o brief com totais, segmentos e flags de meta", () => {
    const result = buildAccountBrief(baseInput());
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    const { brief } = result;

    expect(brief.account.name).toBe("Conta Teste");
    expect(brief.totals.spend).toBe(300);
    expect(brief.segments.campaigns).toHaveLength(2);

    const c2 = brief.segments.campaigns.find((c) => c.id === "c2");
    expect(c2?.name).toBe("Lançamento B");
    expect(c2?.metrics.cpa).toBe(100);
    expect(c2?.flags).toContain("cpa_acima_da_meta");

    const c1 = brief.segments.campaigns.find((c) => c.id === "c1");
    expect(c1?.metrics.cpa).toBe(25);
    expect(c1?.flags).not.toContain("cpa_acima_da_meta");
  });

  it("calcula deltaVsBaseline quando há linha na janela-baseline", () => {
    const result = buildAccountBrief(baseInput());
    if (result.status !== "ok") return;
    const c1 = result.brief.segments.campaigns.find((c) => c.id === "c1");
    // CPA janela = 100/4 = 25; baseline = 90/3 = 30 → delta -5
    expect(c1?.deltaVsBaseline.cpa).toBeCloseTo(-5, 4);
  });

  it("respeita top-N por spend nos segmentos (sem flags forçando seleção)", () => {
    // goals vazio → sem flags; assim o top-N por spend manda sozinho
    const result = buildAccountBrief(baseInput({ topN: 1, goals: {} }));
    if (result.status !== "ok") return;
    // c2 (spend 200) entra por spend; c1 (spend 100) vai p/ a cauda
    expect(result.brief.segments.campaigns.map((c) => c.id)).toEqual(["c2"]);
    expect(result.brief.aggregatesRest.count).toBe(1);
    expect(result.brief.aggregatesRest.spend).toBe(100);
  });

  it("sinaliza 'sem atividade' quando não há gasto/impressões (conta parada)", () => {
    const result = buildAccountBrief(baseInput({ rows: [], baselineRows: [] }));
    expect(result.status).toBe("empty");
  });

  it("agrega o funil de messaging (conta + entidade) com taxas", () => {
    const withFunnel = baseInput({
      rows: [
        { ...row("act_1", "account", 300, 10000, 200, { count: 5, value: 1500 }), funnel: [{ stage: "conversation_started", count: 100 }, { stage: "first_reply", count: 40 }] },
        { ...row("c1", "campaign", 100, 4000, 80, { count: 4, value: 1200 }), funnel: [{ stage: "conversation_started", count: 60 }, { stage: "first_reply", count: 30 }] },
        row("c2", "campaign", 200, 6000, 120, { count: 2, value: 300 }),
      ],
    });
    const result = buildAccountBrief(withFunnel);
    if (result.status !== "ok") return;
    expect(result.brief.funnel?.replyRate).toBeCloseTo(0.4, 4);
    const c1 = result.brief.segments.campaigns.find((c) => c.id === "c1");
    expect(c1?.funnel?.replyRate).toBeCloseTo(0.5, 4);
    const c2 = result.brief.segments.campaigns.find((c) => c.id === "c2");
    expect(c2?.funnel).toBeUndefined(); // sem messaging → sem funil
  });

  it("trends usam só o nível conta (sem somar níveis) → batem com os totais", () => {
    // rows têm account(300) + c1(100) + c2(200) na mesma data; somar todos daria 600.
    const result = buildAccountBrief(baseInput());
    if (result.status !== "ok") return;
    expect(result.brief.trends).toHaveLength(1);
    expect(result.brief.trends[0]?.metrics.spend).toBe(300); // = totals.spend, não 600
  });

  it("trends caem p/ nível campanha quando a conta não reporta por dia", () => {
    // sem linha account → soma as campanhas do dia (100+200=300), sem dupla-contagem de níveis.
    const result = buildAccountBrief(
      baseInput({
        rows: [
          row("c1", "campaign", 100, 4000, 80, { count: 4, value: 1200 }),
          row("c2", "campaign", 200, 6000, 120, { count: 2, value: 300 }),
        ],
      }),
    );
    if (result.status !== "ok") return;
    expect(result.brief.trends).toHaveLength(1);
    expect(result.brief.trends[0]?.metrics.spend).toBe(300);
  });

  it("preserva roas=0 quando há gasto e receita zero (sinal 'gastando, sem retorno')", () => {
    // c1 tem objetivo purchase, gasto 300 e receita reportada = 0 → roas deve ser 0
    // (não undefined). value:0 explícito na conversão (o adapter reporta 0, não omite).
    const c1Row: InsightRow = {
      entityId: "c1",
      level: "campaign",
      date: "2026-08-10",
      metrics: { spend: 300, impressions: 10000, clicks: 200, ctr: 0, cpc: 0, cpm: 0 },
      conversions: [{ goal: "purchase", count: 5, value: 0 }],
    };
    const result = buildAccountBrief(
      baseInput({
        rows: [row("act_1", "account", 300, 10000, 200), c1Row],
        baselineRows: [],
      }),
    );
    if (result.status !== "ok") return;
    const c1 = result.brief.segments.campaigns.find((c) => c.id === "c1");
    expect(c1?.metrics.roas).toBe(0);
  });

  it("detecta anomalia (z-score) e a vira flag (entra no brief mesmo com spend baixo)", () => {
    // 5 campanhas normais (CPA ~25) + 1 outlier (CPA 1000) → z-score > 2 (n=6).
    const normals = [1, 2, 3, 4, 5].map((i) =>
      row(`c${i}`, "campaign", 100, 4000, 80, { count: 4, value: 1200 }),
    );
    const outlier = row("cX", "campaign", 100, 4000, 80, { count: 0.1, value: 20 }); // CPA 1000
    const entitiesEx: AdEntity[] = [1, 2, 3, 4, 5]
      .map((i) => ({ id: `c${i}`, level: "campaign" as const, name: `C${i}`, status: "active" as const, objective: { goal: "purchase" as const } }))
      .concat([{ id: "cX", level: "campaign", name: "CX", status: "active", objective: { goal: "purchase" } }]);
    const rows = [row("act_1", "account", 600, 24000, 480, { count: 20, value: 6020 }), ...normals, outlier];

    const result = buildAccountBrief(baseInput({ rows, baselineRows: [], entities: entitiesEx, goals: {}, topN: 1 }));
    if (result.status !== "ok") return;
    expect(result.brief.anomalies.some((a) => a.entityId === "cX")).toBe(true);
    // cX é flagado por anomalia → entra na seleção mesmo com topN=1
    expect(result.brief.segments.campaigns.some((c) => c.id === "cX")).toBe(true);
  });
});
