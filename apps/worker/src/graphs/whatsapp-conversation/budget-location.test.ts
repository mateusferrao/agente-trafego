import { describe, expect, it, vi } from "vitest";
import type { AdsPlatformPort } from "@trafego/shared/ports";
import {
  adHasNoBudgetMessage,
  budgetLivesOnAdsetsMessage,
  budgetLivesOnCampaignMessage,
  resolveMisplacedBudgetMessage,
} from "./budget-location.js";

const account = { adAccountId: "act_1", accessToken: "tok" };

describe("mensagens honestas de onde mora o orçamento", () => {
  it("anúncio: explica que não tem orçamento próprio + aponta conjunto/campanha + isolamento", () => {
    const m = adHasNoBudgetMessage("Anúncio A", "");
    expect(m).toContain("anúncio não tem orçamento próprio");
    expect(m).toContain("conjunto");
    expect(m).toContain("campanha");
    expect(m).toContain("isolá-lo"); // sinaliza o isolamento (fast-follow), sem prometer clique
  });
  it("CBO: oferta ajustar na campanha COM aviso de blast radius (todos os conjuntos)", () => {
    const m = budgetLivesOnCampaignMessage("Conjunto X", " (Conta Y)");
    expect(m).toContain("CBO");
    expect(m).toContain("todos os conjuntos");
    expect(m).toContain("(Conta Y)");
  });
  it("ABO: pede qual conjunto ajustar (nunca chuta um)", () => {
    const m = budgetLivesOnAdsetsMessage("Campanha Z", "");
    expect(m).toContain("ABO");
    expect(m).toContain("qual conjunto");
  });
});

describe("resolveMisplacedBudgetMessage (IO)", () => {
  const ads = (over: Partial<AdsPlatformPort>): AdsPlatformPort => over as AdsPlatformPort;

  it("adset sem orçamento + campanha COM orçamento → oferta CBO na campanha", async () => {
    const port = ads({ getAdSetCampaignBudget: vi.fn(async () => ({ campaignId: "c1", dailyBudgetMinor: 5000, lifetimeBudgetMinor: 0 })) });
    const m = await resolveMisplacedBudgetMessage(port, account, "adset", "as1", "Conjunto X", "");
    expect(m).toContain("CBO");
  });

  it("adset sem orçamento E campanha sem orçamento → null (não é caso de nível; fluxo normal)", async () => {
    const port = ads({ getAdSetCampaignBudget: vi.fn(async () => ({ campaignId: "c1", dailyBudgetMinor: 0, lifetimeBudgetMinor: 0 })) });
    expect(await resolveMisplacedBudgetMessage(port, account, "adset", "as1", "Conjunto X", "")).toBeNull();
  });

  it("campanha ABO (sem orçamento único, com conjuntos) → pede qual conjunto", async () => {
    const port = ads({ getCampaignBudgetLayout: vi.fn(async () => ({ campaignDailyMinor: null, adsets: [{ id: "as1", dailyMinor: 3000 }] })) });
    const m = await resolveMisplacedBudgetMessage(port, account, "campaign", "c1", "Campanha Z", "");
    expect(m).toContain("qual conjunto");
  });

  it("campanha CBO (tem orçamento único) → null (não é ABO; fluxo normal)", async () => {
    const port = ads({ getCampaignBudgetLayout: vi.fn(async () => ({ campaignDailyMinor: 8000, adsets: [] })) });
    expect(await resolveMisplacedBudgetMessage(port, account, "campaign", "c1", "Campanha Z", "")).toBeNull();
  });
});
