import { afterEach, describe, expect, it, vi } from "vitest";
import { AdsPlatformError } from "@trafego/shared/ports";
import { MetaGraphClient } from "./client.js";
import { MetaCreationService } from "./creation.js";

const account = { adAccountId: "act_123", accessToken: "tok" };

/** Stub: /copies devolve a cópia; POST no id da cópia (override de budget) devolve success. */
function stubGraph(copiesBody: Record<string, unknown>) {
  const posts: Array<{ url: string }> = [];
  const spy = vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    posts.push({ url });
    const body = url.includes("/copies") ? copiesBody : { success: true };
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", spy);
  return { posts: () => posts };
}

afterEach(() => vi.unstubAllGlobals());

function svc() {
  return new MetaCreationService(new MetaGraphClient({ graphVersion: "v26.0" }));
}

describe("MetaCreationService.duplicateEntity", () => {
  it("copia adset e retorna copiedId + childIds", async () => {
    stubGraph({
      copied_adset_id: "AS_NEW",
      // shape real v26: o adset copiado + os ads copiados (só os "ad" são childIds).
      ad_object_ids: [
        { ad_object_type: "ad_set", source_id: "AS1", copied_id: "AS_NEW" },
        { ad_object_type: "ad", source_id: "AD1", copied_id: "AD1_NEW" },
        { ad_object_type: "ad", source_id: "AD2", copied_id: "AD2_NEW" },
      ],
    });
    const res = await svc().duplicateEntity(account, {
      sourceLevel: "adset",
      sourceId: "AS1",
      status: "paused",
    });
    expect(res.copiedId).toBe("AS_NEW");
    expect(res.childIds).toEqual(["AD1_NEW", "AD2_NEW"]);
  });

  it("duplicateEntity NÃO aplica budget (passo separado) — só /copies", async () => {
    const { posts } = stubGraph({ copied_adset_id: "AS_NEW", ad_object_ids: [] });
    await svc().duplicateEntity(account, { sourceLevel: "adset", sourceId: "AS1", status: "active" });
    const urls = posts().map((p) => p.url);
    expect(urls.some((u) => u.includes("AS1/copies"))).toBe(true);
    expect(urls.some((u) => u.includes("daily_budget"))).toBe(false);
  });

  it("setEntityBudget faz POST de daily_budget na entidade", async () => {
    const { posts } = stubGraph({ success: true });
    await svc().setEntityBudget(account, "AS_NEW", 9000);
    expect(posts().some((p) => p.url.includes("/AS_NEW") && p.url.includes("daily_budget=9000"))).toBe(true);
  });

  it("passa status_option ACTIVE/PAUSED no /copies", async () => {
    const { posts } = stubGraph({ copied_adset_id: "AS_NEW", ad_object_ids: [] });
    await svc().duplicateEntity(account, { sourceLevel: "adset", sourceId: "AS1", status: "paused" });
    const copies = posts().find((p) => p.url.includes("/copies"))!;
    expect(copies.url).toContain("status_option=PAUSED");
  });

  it("vencedor legado (subcode 3858504) → AdsPlatformError kind neutro not_duplicable + userMessage (subcode não vaza)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            error: {
              message: "Invalid parameter",
              code: 100,
              error_subcode: 3858504,
              error_user_msg: "O criativo não deve incluir aprimoramentos padrão.",
            },
          }),
          { status: 400, headers: { "content-type": "application/json" } },
        ),
      ),
    );
    const err = await svc()
      .duplicateEntity(account, { sourceLevel: "adset", sourceId: "AS1", status: "paused" })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AdsPlatformError);
    expect(err).toMatchObject({ kind: "not_duplicable", userMessage: "O criativo não deve incluir aprimoramentos padrão." });
    // o subcode Meta NÃO vaza pro erro neutro (fica interno ao adapter).
    expect(err).not.toHaveProperty("subcode");
  });

  it("outros erros do /copies → NÃO viram not_duplicable (propagam p/ toAdsError)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ error: { message: "boom", code: 1 } }), {
          status: 400,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
    const err = await svc()
      .duplicateEntity(account, { sourceLevel: "adset", sourceId: "AS1", status: "paused" })
      .catch((e: unknown) => e);
    // não é AdsPlatformError (a tradução p/ port é do adapter, não do service) — é o MetaApiError cru.
    expect(err).not.toBeInstanceOf(AdsPlatformError);
    expect((err as Error).name).toBe("MetaApiError");
  });
});

/** Stub que devolve {id} em TODO POST (create* espera id). */
function stubCreate(id: string) {
  const posts: Array<{ url: string }> = [];
  const spy = vi.fn(async (input: string | URL | Request) => {
    posts.push({ url: String(input) });
    return new Response(JSON.stringify({ id }), { status: 200, headers: { "content-type": "application/json" } });
  });
  vi.stubGlobal("fetch", spy);
  return { posts: () => posts };
}

// Regressão dos contratos validados no E2E real (Meta v26): campanha ABO exige
// is_adset_budget_sharing_enabled; o bid vai no adset (LOWEST_COST_WITHOUT_CAP).
describe("MetaCreationService.createCampaign / createAdSet — contrato v26", () => {
  it("createCampaign envia special_ad_categories + is_adset_budget_sharing_enabled=false (ABO)", async () => {
    const { posts } = stubCreate("CAMP1");
    const r = await svc().createCampaign(account, {
      name: "C",
      objectiveGoal: "lead",
      specialAdCategories: [],
      status: "paused",
    });
    expect(r.campaignId).toBe("CAMP1");
    const u = posts().find((p) => p.url.includes("/campaigns"))!.url;
    expect(u).toContain("objective=OUTCOME_LEADS");
    expect(u).toContain("is_adset_budget_sharing_enabled=false");
    expect(u).toContain("special_ad_categories=%5B%5D"); // "[]"
    expect(u).not.toContain("bid_strategy"); // bid vai no adset, não na campanha (ABO)
  });

  it("createAdSet põe o bid_strategy no adset + optimization/billing/promoted_object", async () => {
    const { posts } = stubCreate("AS1");
    const r = await svc().createAdSet(account, {
      campaignId: "CAMP1",
      name: "A",
      dailyBudgetMinor: 1000,
      goal: "purchase",
      pixelId: "PX1",
      targeting: { kind: "advantage_plus" },
      status: "paused",
    });
    expect(r.adsetId).toBe("AS1");
    expect(r.targetingFallback).toBe(false); // advantage_plus foi o PEDIDO, não um fallback
    const u = posts().find((p) => p.url.includes("/adsets"))!.url;
    expect(u).toContain("bid_strategy=LOWEST_COST_WITHOUT_CAP");
    expect(u).toContain("optimization_goal=OFFSITE_CONVERSIONS");
    expect(u).toContain("billing_event=IMPRESSIONS");
    expect(u).toContain("daily_budget=1000");
    expect(u).toContain("promoted_object="); // pixel + custom_event_type
  });

  /** Stub que distingue o GET de leitura do targeting-fonte (path = sourceAdsetId) do POST de
   *  criação (/adsets) — só assim dá pra testar reuse_adset de ponta a ponta. */
  function stubReuseAdset(sourceAdsetId: string, sourceResponse: "ok" | "not_found") {
    const posts: Array<{ url: string; method: string }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        posts.push({ url, method: String(init?.method ?? "GET") });
        if (url.includes(`/${sourceAdsetId}?`) || url.endsWith(`/${sourceAdsetId}`)) {
          if (sourceResponse === "not_found") {
            return new Response(JSON.stringify({ error: { message: "Unsupported get request", code: 100 } }), {
              status: 400,
              headers: { "content-type": "application/json" },
            });
          }
          return new Response(JSON.stringify({ targeting: { geo_locations: { cities: [{ key: "123" }] } } }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        return new Response(JSON.stringify({ id: "AS_NEW" }), { status: 200, headers: { "content-type": "application/json" } });
      }),
    );
    return { posts: () => posts };
  }

  it("reuse_adset: fonte disponível → herda o targeting dela, targetingFallback=false", async () => {
    const { posts } = stubReuseAdset("AS_WINNER", "ok");
    const r = await svc().createAdSet(account, {
      campaignId: "CAMP1",
      name: "A",
      dailyBudgetMinor: 1000,
      goal: "purchase",
      targeting: { kind: "reuse_adset", sourceAdsetId: "AS_WINNER" },
      status: "paused",
    });
    expect(r.targetingFallback).toBe(false);
    const adsetPost = posts().find((p) => p.url.includes("/adsets"))!;
    expect(decodeURIComponent(adsetPost.url)).toContain('"cities":[{"key":"123"}]');
  });

  it("reuse_adset: fonte indisponível (deletada/pausada) → cai em Advantage+ e sinaliza targetingFallback=true (nunca silencioso)", async () => {
    const { posts } = stubReuseAdset("AS_GONE", "not_found");
    const r = await svc().createAdSet(account, {
      campaignId: "CAMP1",
      name: "A",
      dailyBudgetMinor: 1000,
      goal: "purchase",
      targeting: { kind: "reuse_adset", sourceAdsetId: "AS_GONE" },
      status: "paused",
    });
    expect(r.targetingFallback).toBe(true);
    const adsetPost = posts().find((p) => p.url.includes("/adsets"))!;
    expect(decodeURIComponent(adsetPost.url)).toContain('"advantage_audience":1');
  });
});

/** Stub do /ads: devolve uma lista fixa de candidatos pra inferCreationDefaults. */
function stubAds(data: Record<string, unknown>[]) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify({ data }), { status: 200, headers: { "content-type": "application/json" } })),
  );
}

describe("MetaCreationService.inferCreationDefaults", () => {
  it("devolve sourceAdsetId do melhor anúncio reusável, pra herdar o público provado (reuse_adset)", async () => {
    stubAds([
      {
        id: "AD1",
        effective_status: "ACTIVE",
        creative: { object_story_spec: { link_data: { image_hash: "HASH1", link: "https://x.test" } } },
        adset: { id: "AS_WINNER", promoted_object: { pixel_id: "PX1" } },
        campaign: { objective: "OUTCOME_LEADS" },
        insights: { data: [{ spend: "100", actions: [{ action_type: "lead", value: "5" }] }] },
      },
    ]);
    const r = await svc().inferCreationDefaults(account);
    expect(r.sourceAdsetId).toBe("AS_WINNER");
    expect(r.pixelId).toBe("PX1");
  });

  it("sem adset.id no anúncio candidato (shape antigo/parcial) → sourceAdsetId ausente, sem quebrar", async () => {
    stubAds([
      {
        id: "AD1",
        effective_status: "ACTIVE",
        creative: { object_story_spec: { link_data: { image_hash: "HASH1" } } },
        campaign: { objective: "OUTCOME_LEADS" },
        insights: { data: [{ spend: "100", actions: [] }] },
      },
    ]);
    const r = await svc().inferCreationDefaults(account);
    expect(r.sourceAdsetId).toBeUndefined();
  });
});
