import { afterEach, describe, expect, it, vi } from "vitest";
import type { Redis } from "ioredis";
import { MetaCampaignStructureService } from "./campaign-structure.js";
import { MetaGraphClient } from "./client.js";
import { MetaGovernor } from "./governor.js";

class FakeRedis {
  private store = new Map<string, { value: string; expiresAt: number | null }>();
  async set(): Promise<"OK"> {
    return "OK";
  }
  async pttl(): Promise<number> {
    return -1;
  }
}
const account = { adAccountId: "123", accessToken: "tok" };

function stubGraph(routes: { campaign: unknown; adsets: unknown; ads: unknown }): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { "content-type": "application/json" } });
      if (url.includes("/adsets")) return json(routes.adsets);
      if (url.includes("/ads")) return json(routes.ads);
      return json(routes.campaign);
    }),
  );
}
afterEach(() => vi.unstubAllGlobals());

function makeService(): MetaCampaignStructureService {
  const gov = new MetaGovernor({ redis: new FakeRedis() as unknown as Redis, rng: () => 0 });
  return new MetaCampaignStructureService(new MetaGraphClient({ graphVersion: "v26.0" }), gov);
}

describe("MetaCampaignStructureService.read", () => {
  it("CBO (budget na campanha) + N criativos reais + conjunto ativo como fonte", async () => {
    stubGraph({
      campaign: { name: "[1398] ESCALA", objective: "OUTCOME_LEADS", daily_budget: "15000", special_ad_categories: [] },
      adsets: {
        data: [
          { id: "SET_PAUSED", effective_status: "PAUSED", optimization_goal: "OFFSITE_CONVERSIONS" },
          { id: "SET_ACTIVE", effective_status: "ACTIVE", optimization_goal: "OFFSITE_CONVERSIONS", targeting: { geo_locations: { cities: [{ name: "BH" }] }, age_min: 45 } },
        ],
      },
      ads: {
        data: [
          { id: "AD1", effective_status: "ACTIVE", creative: { id: "CR1" } },
          { id: "AD2", effective_status: "PAUSED", creative: { id: "CR2" } },
        ],
      },
    });
    const s = await makeService().read(account, "CMP1", "act_123");
    expect(s.budgetMode).toBe("cbo");
    expect(s.dailyBudgetMinor).toBe(15000);
    expect(s.sourceAdsetId).toBe("SET_ACTIVE"); // ativo preferido
    expect(s.creativeRefs).toEqual(["CR1", "CR2"]); // ativo primeiro
    expect(s.name).toBe("[1398] ESCALA");
  });

  it("ABO (budget no conjunto) → budgetMode abo", async () => {
    stubGraph({
      campaign: { name: "C", objective: "OUTCOME_ENGAGEMENT" },
      adsets: { data: [{ id: "S1", effective_status: "ACTIVE", daily_budget: "8000" }] },
      ads: { data: [{ id: "A1", effective_status: "ACTIVE", creative: { id: "C1" } }] },
    });
    const s = await makeService().read(account, "CMP2", "act_123");
    expect(s.budgetMode).toBe("abo");
    expect(s.dailyBudgetMinor).toBe(8000);
  });

  it("CONVERSAS (CTWA): captura a Página de destino do promoted_object → structure.pageId (bug prod: sem ela a cópia era recusada)", async () => {
    stubGraph({
      campaign: { name: "Conversas WA", objective: "OUTCOME_ENGAGEMENT" },
      adsets: {
        data: [
          {
            id: "SET_WA",
            effective_status: "ACTIVE",
            optimization_goal: "CONVERSATIONS",
            promoted_object: { page_id: "PAGE_123" },
            daily_budget: "5000",
          },
        ],
      },
      ads: { data: [{ id: "AD1", effective_status: "ACTIVE", creative: { id: "CR1" } }] },
    });
    const s = await makeService().read(account, "CMP_WA", "act_123");
    expect(s.pageId).toBe("PAGE_123");
    expect(s.pixelId).toBeUndefined();
  });

  it("conversão com pixel → captura pixelId, sem pageId (OFFSITE não exige Página)", async () => {
    stubGraph({
      campaign: { name: "Vendas", objective: "OUTCOME_SALES", daily_budget: "10000", special_ad_categories: [] },
      adsets: { data: [{ id: "S1", effective_status: "ACTIVE", optimization_goal: "OFFSITE_CONVERSIONS", promoted_object: { pixel_id: "PX_9" } }] },
      ads: { data: [{ id: "A1", effective_status: "ACTIVE", creative: { id: "C1" } }] },
    });
    const s = await makeService().read(account, "CMP_S", "act_123");
    expect(s.pixelId).toBe("PX_9");
    expect(s.pageId).toBeUndefined();
  });
});
