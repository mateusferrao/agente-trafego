import { describe, expect, it } from "vitest";
import { countCreationsLast24h, planOrphanCleanup, runFromScratchSaga } from "./apply-draft.js";
import type { Database } from "@trafego/db/client";
import type { CampaignDraft } from "@trafego/shared";
import { AdsPlatformError, type AdAccountRef } from "@trafego/shared/ports";
import type { WorkerDeps } from "../../composition.js";

// ── B2: plano de limpeza da órfã do-zero (decisão pura do catch) ──────────
describe("planOrphanCleanup — rollback da órfã (B2)", () => {
  const deterministic = new AdsPlatformError("not_accessible", "tech", "Recusado");
  const transient = new AdsPlatformError("rate_limited", "throttle");

  it("from_scratch + campanha criada + erro DETERMINÍSTICO → delete (apaga a órfã)", () => {
    expect(planOrphanCleanup(deterministic, "from_scratch", "camp1")).toEqual({ action: "delete", campaignId: "camp1" });
  });
  it("from_scratch + campanha criada + erro TRANSIENTE → keep (mantém, retomável)", () => {
    expect(planOrphanCleanup(transient, "from_scratch", "camp1")).toEqual({ action: "keep", campaignId: "camp1" });
  });
  it("non-AdsPlatformError (transiente por padrão) → keep (não apaga)", () => {
    expect(planOrphanCleanup(new Error("boom"), "from_scratch", "camp1")).toEqual({ action: "keep", campaignId: "camp1" });
  });
  it("nenhuma campanha criada (falhou antes) → none", () => {
    expect(planOrphanCleanup(deterministic, "from_scratch", undefined)).toEqual({ action: "none" });
  });
  it("duplicação (atômica — reverte sozinha) → none mesmo com id", () => {
    expect(planOrphanCleanup(deterministic, "duplicate", "camp1")).toEqual({ action: "none" });
  });
});

/** db fake sequencial: cada select().from().where() (sem .limit — count() é lido direto)
 *  consome UM resultado da fila, em ordem. Prova o bug (P0.4): o cap agora conta pelo
 *  APPLY-TIME real (agent_tool_calls), não pelo createdAt do rascunho, + soma o em-voo
 *  (campaign_drafts `creating`) só quando o agente NÃO está em dry-run. */
function fakeDb(rows: unknown[][]): { db: Database; calls: string[] } {
  const queue = [...rows];
  const calls: string[] = [];
  const db = {
    select: () => ({
      from: (table: { [Symbol.toPrimitive]?: () => string } | Record<string, unknown>) => ({
        where: () => {
          // registra qual tabela foi consultada (agentToolCalls tem coluna toolKey; campaignDrafts tem coluna status).
          calls.push("toolKey" in (table as Record<string, unknown>) ? "agentToolCalls" : "campaignDrafts");
          const result = queue.shift() ?? [];
          return { then: (resolve: (v: unknown) => void) => resolve(result) };
        },
      }),
    }),
  } as unknown as Database;
  return { db, calls };
}

describe("countCreationsLast24h", () => {
  it("dry-run: conta só agent_tool_calls (apply-time real), não consulta o em-voo", async () => {
    const { db, calls } = fakeDb([[{ n: 2 }]]);
    const n = await countCreationsLast24h(db, { agentId: "a1", adAccountId: "acc1", dryRun: true });
    expect(n).toBe(2);
    expect(calls).toEqual(["agentToolCalls"]);
  });

  it("soma aplicado (apply-time) + em-voo (creating do mesmo agente)", async () => {
    const { db, calls } = fakeDb([[{ n: 1 }], [{ n: 2 }]]);
    const n = await countCreationsLast24h(db, { agentId: "a1", adAccountId: "acc1", dryRun: false });
    expect(n).toBe(3);
    expect(calls).toEqual(["agentToolCalls", "campaignDrafts"]);
  });

  it("sem nenhuma criação recente nem em-voo → 0", async () => {
    const { db } = fakeDb([[], []]);
    const n = await countCreationsLast24h(db, { agentId: "a1", adAccountId: "acc1", dryRun: false });
    expect(n).toBe(0);
  });
});

// ── C2: saga N-conjuntos (criativo compartilhado, retomável) ──────────────
function fakeAds() {
  const calls = { campaigns: [] as any[], adsets: [] as any[], creatives: [] as any[], ads: [] as any[] };
  let c = 0, as = 0, cr = 0, ad = 0;
  const ads = {
    createCampaign: async (_ref: unknown, input: unknown) => { calls.campaigns.push(input); return { campaignId: `camp${++c}` }; },
    createAdSet: async (_ref: unknown, input: unknown) => { calls.adsets.push(input); return { adsetId: `as${++as}`, targetingFallback: false }; },
    createAdCreative: async (_ref: unknown, input: unknown) => { calls.creatives.push(input); return { creativeId: `cr${++cr}` }; },
    createAd: async (_ref: unknown, input: unknown) => { calls.ads.push(input); return { adId: `ad${++ad}` }; },
  } as unknown as WorkerDeps["ports"]["ads"];
  return { ads, calls };
}

const REF: AdAccountRef = { adAccountId: "act_1", accessToken: "tok" };
const copy = { primaryText: "t", headline: "h" };
function draftOf(specOver: Partial<CampaignDraft["spec"]>): CampaignDraft {
  return {
    kind: "from_scratch",
    spec: {
      version: 1, currency: "BRL", dailyBudgetMinor: 3000, activation: "paused",
      objective: "purchase", pageId: "PAGE1",
      creative: { assetId: "a", format: "image", origin: "reuse", metaImageHash: "IMG" },
      copyVariants: [copy], ...specOver,
    },
  } as CampaignDraft;
}
async function runSaga(draft: CampaignDraft, state: Record<string, unknown> = {}) {
  const { ads, calls } = fakeAds();
  const persist = async (patch: Record<string, unknown>) => { Object.assign(state, patch); };
  await runFromScratchSaga(ads, draft, REF, state, persist);
  return { calls, state };
}

describe("runFromScratchSaga — C2 multi-conjunto (criativo compartilhado)", () => {
  it("2 conjuntos, 1 variação: 1 campanha + 2 conjuntos + 1 criativo (UMA vez) + 2 anúncios referenciando o mesmo", async () => {
    const draft = draftOf({
      budgetMode: "cbo",
      adsets: [
        { name: "Público A", targeting: { kind: "advantage_plus" } },
        { name: "Público B", targeting: { kind: "explicit", geo: [{ key: "BR", name: "Brasil", kind: "country" }] } },
      ],
    });
    const { calls, state } = await runSaga(draft);
    expect(calls.campaigns).toHaveLength(1);
    expect(calls.adsets).toHaveLength(2);
    // criativo COMPARTILHADO: criado UMA vez, não 1 por conjunto
    expect(calls.creatives).toHaveLength(1);
    // 2 anúncios (1 por conjunto), AMBOS referenciando o mesmo creativeId
    expect(calls.ads).toHaveLength(2);
    expect(calls.ads.map((a) => a.creativeId)).toEqual(["cr1", "cr1"]);
    expect(calls.ads.map((a) => a.adsetId)).toEqual(["as1", "as2"]);
    // CBO: nenhum conjunto leva orçamento (está na campanha)
    expect(calls.adsets.every((a) => a.dailyBudgetMinor === undefined)).toBe(true);
    expect(state["sharedCreativeIds"]).toEqual(["cr1"]);
    expect(state["adsetIds"]).toEqual(["as1", "as2"]);
  });

  it("ABO multi-conjunto: cada conjunto leva o próprio orçamento (ou o do spec)", async () => {
    const draft = draftOf({
      budgetMode: "abo",
      adsets: [
        { name: "A", targeting: { kind: "advantage_plus" }, dailyBudgetMinor: 5000 },
        { name: "B", targeting: { kind: "advantage_plus" } },
      ],
    });
    const { calls } = await runSaga(draft);
    expect(calls.adsets[0].dailyBudgetMinor).toBe(5000); // próprio
    expect(calls.adsets[1].dailyBudgetMinor).toBe(3000); // fallback pro do spec
  });

  it("retoma sem duplicar: campanha + 1º conjunto já criados são pulados", async () => {
    const draft = draftOf({
      budgetMode: "cbo",
      adsets: [
        { name: "A", targeting: { kind: "advantage_plus" } },
        { name: "B", targeting: { kind: "advantage_plus" } },
      ],
    });
    // estado parcial: campanha + 1º conjunto + criativo compartilhado + o anúncio do 1º conjunto já criados
    const state = { campaignId: "camp0", adsetIds: ["as0"], sharedCreativeIds: ["crShared"], adIdsByAdset: [["adPrev"]] };
    const { calls } = await runSaga(draft, state);
    expect(calls.campaigns).toHaveLength(0); // não recria a campanha
    expect(calls.adsets).toHaveLength(1); // só o 2º conjunto
    expect(calls.creatives).toHaveLength(0); // criativo compartilhado já existe
    expect(calls.ads).toHaveLength(1); // só o anúncio do 2º conjunto
    expect(calls.ads[0].creativeId).toBe("crShared"); // referencia o compartilhado gravado
  });

  it("criativo POR CONJUNTO (U1): conjunto com `creative` próprio cria criativo EXCLUSIVO; sem override reusa o compartilhado", async () => {
    const draft = draftOf({
      budgetMode: "cbo",
      adsets: [
        { name: "A", targeting: { kind: "advantage_plus" } }, // usa o compartilhado
        { name: "B", targeting: { kind: "advantage_plus" }, creative: { assetId: "b", format: "image", origin: "reuse", metaImageHash: "IMG_B" } },
      ],
    });
    const { calls } = await runSaga(draft);
    // 2 criativos: 1 compartilhado (conjunto A) + 1 exclusivo do conjunto B
    expect(calls.creatives).toHaveLength(2);
    // cada conjunto referencia um creativeId (A o compartilhado, B o exclusivo) — ids distintos
    expect(new Set(calls.ads.map((a) => a.creativeId)).size).toBe(2);
    expect(calls.ads.map((a) => a.adsetId)).toEqual(["as1", "as2"]);
  });

  it("retrocompat: SEM adsets = single-conjunto (1 campanha, 1 conjunto, N criativos, N anúncios)", async () => {
    const draft = draftOf({ budgetMode: "cbo", copyVariants: [copy, { primaryText: "t2", headline: "h2" }] });
    const { calls } = await runSaga(draft);
    expect(calls.campaigns).toHaveLength(1);
    expect(calls.adsets).toHaveLength(1);
    expect(calls.creatives).toHaveLength(2); // single: 1 criativo por variação
    expect(calls.ads).toHaveLength(2);
  });
});
