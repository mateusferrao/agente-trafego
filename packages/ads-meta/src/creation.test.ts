import { afterEach, describe, expect, it, vi } from "vitest";
import type { Redis } from "ioredis";
import { AdsPlatformError } from "@trafego/shared/ports";
import { MetaGraphClient } from "./client.js";
import { MetaCreationService } from "./creation.js";
import { MetaGovernor } from "./governor.js";

const account = { adAccountId: "act_123", accessToken: "tok" };

/** Redis in-memory mínimo (set EX, pttl) p/ o governor nos reads governados. */
class FakeRedis {
  private store = new Map<string, { value: string; expiresAt: number | null }>();
  async set(key: string, value: string, mode?: string, ttlSec?: number): Promise<"OK"> {
    this.store.set(key, { value, expiresAt: mode === "EX" && ttlSec ? Date.now() + ttlSec * 1000 : null });
    return "OK";
  }
  async pttl(key: string): Promise<number> {
    const e = this.store.get(key);
    if (!e) return -2;
    if (e.expiresAt === null) return -1;
    const ms = e.expiresAt - Date.now();
    return ms > 0 ? ms : -2;
  }
}
const governor = (): MetaGovernor => new MetaGovernor({ redis: new FakeRedis() as unknown as Redis, rng: () => 0 });

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
    // o adset-raiz É o copiedId — não relistado como intermediário.
    expect(res.childAdsetIds).toEqual([]);
  });

  it("deep_copy de CAMPANHA → childAdsetIds tem os adsets intermediários (ativar a árvore inteira)", async () => {
    stubGraph({
      copied_campaign_id: "C_NEW",
      ad_object_ids: [
        { ad_object_type: "campaign", source_id: "C1", copied_id: "C_NEW" },
        { ad_object_type: "ad_set", source_id: "AS1", copied_id: "AS1_NEW" },
        { ad_object_type: "ad_set", source_id: "AS2", copied_id: "AS2_NEW" },
        { ad_object_type: "ad", source_id: "AD1", copied_id: "AD1_NEW" },
      ],
    });
    const res = await svc().duplicateEntity(account, { sourceLevel: "campaign", sourceId: "C1", status: "paused" });
    expect(res.copiedId).toBe("C_NEW");
    expect(res.childAdsetIds).toEqual(["AS1_NEW", "AS2_NEW"]);
    expect(res.childIds).toEqual(["AD1_NEW"]);
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

/** Stub do /delivery_estimate: captura a URL (params) e devolve o `data:[row]` dado. */
function stubEstimate(row: Record<string, unknown> | null) {
  const urls: string[] = [];
  const spy = vi.fn(async (input: string | URL | Request) => {
    urls.push(String(input));
    return new Response(JSON.stringify({ data: row ? [row] : [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", spy);
  return { urls: () => urls };
}

describe("MetaCreationService.deliveryEstimate", () => {
  it("mapeia estimate_ready + estimate_dau → { ready, dailyActiveUsers }", async () => {
    stubEstimate({ estimate_ready: true, estimate_dau: 25000, estimate_mau_lower_bound: 400000, estimate_mau_upper_bound: 600000 });
    const est = await svc().deliveryEstimate(account, { targeting: { kind: "advantage_plus" }, goal: "lead" }, governor());
    expect(est).toEqual({ ready: true, dailyActiveUsers: 25000, monthlyReachMin: 400000, monthlyReachMax: 600000 });
  });

  it("estimate_dau = -1 (ainda não estimou) → ready true SEM contagem", async () => {
    stubEstimate({ estimate_ready: true, estimate_dau: -1, estimate_mau_lower_bound: -1, estimate_mau_upper_bound: -1 });
    const est = await svc().deliveryEstimate(account, { targeting: { kind: "advantage_plus" }, goal: "lead" }, governor());
    expect(est).toEqual({ ready: true });
  });

  it("estimate_ready false → { ready: false }", async () => {
    stubEstimate({ estimate_ready: false, estimate_dau: 100 });
    const est = await svc().deliveryEstimate(account, { targeting: { kind: "advantage_plus" }, goal: "lead" }, governor());
    expect(est).toEqual({ ready: false });
  });

  it("data vazio → { ready: false }", async () => {
    stubEstimate(null);
    const est = await svc().deliveryEstimate(account, { targeting: { kind: "advantage_plus" }, goal: "lead" }, governor());
    expect(est).toEqual({ ready: false });
  });

  it("envia optimization_goal + targeting_spec com os públicos incluídos/excluídos", async () => {
    const { urls } = stubEstimate({ estimate_ready: true, estimate_dau: 5000 });
    await svc().deliveryEstimate(
      account,
      { targeting: { kind: "explicit", geo: [{ key: "BR", name: "Brasil", kind: "country" }], customAudienceIncludeIds: ["AUD_IN"], customAudienceExcludeIds: ["AUD_OUT"] }, goal: "lead" },
      governor(),
    );
    const url = decodeURIComponent(urls()[0]!);
    expect(url).toContain("/act_123/delivery_estimate");
    expect(url).toContain("optimization_goal=LEAD_GENERATION");
    expect(url).toContain("AUD_IN");
    expect(url).toContain("AUD_OUT");
  });
});

describe("MetaCreationService.deliveryEstimateForAdSet (teto de escala por audiência, Fase 4)", () => {
  it("chama GET /{adsetId}/delivery_estimate SEM targeting_spec (usa a config atual do próprio adset)", async () => {
    const { urls } = stubEstimate({ estimate_ready: true, estimate_dau: 1000, estimate_mau_lower_bound: 20000, estimate_mau_upper_bound: 30000 });
    const est = await svc().deliveryEstimateForAdSet(account, "AS1", governor());
    expect(est).toEqual({ ready: true, dailyActiveUsers: 1000, monthlyReachMin: 20000, monthlyReachMax: 30000 });
    const url = decodeURIComponent(urls()[0]!);
    expect(url).toContain("/AS1/delivery_estimate");
    expect(url).not.toContain("targeting_spec");
  });

  it("ready false (público novo/lookalike ainda sem estimativa) → { ready: false }", async () => {
    stubEstimate({ estimate_ready: false });
    const est = await svc().deliveryEstimateForAdSet(account, "AS1", governor());
    expect(est).toEqual({ ready: false });
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

  it("reuse_adset COM snapshot resolvido (subfatia 2) → monta targeting DIRETO, ZERO chamada Graph pra fonte", async () => {
    const posts: Array<{ url: string }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        posts.push({ url });
        // se cair aqui pra ler a fonte, o teste falha (não deveria ter nenhum GET no sourceAdsetId).
        if (url.includes("AS_WINNER")) throw new Error("não deveria reler a fonte — snapshot já resolvido");
        return new Response(JSON.stringify({ id: "AS_NEW" }), { status: 200, headers: { "content-type": "application/json" } });
      }),
    );
    const r = await svc().createAdSet(account, {
      campaignId: "CAMP1",
      name: "A",
      dailyBudgetMinor: 1000,
      goal: "purchase",
      targeting: {
        kind: "reuse_adset",
        sourceAdsetId: "AS_WINNER",
        resolved: {
          geo: { cities: [{ key: "123", name: "Belo Horizonte" }] },
          ageMin: 35,
          ageMax: 64,
          interestGroups: [[{ id: "i1", name: "Estética" }]],
          customAudienceIncludeIds: ["ca1"],
          customAudienceExcludeIds: ["ca2"],
          expansionRaw: { advantageAudience: 0, relaxCustomAudience: 0, relaxLookalike: 0 },
        },
      },
      status: "paused",
    });
    expect(r.targetingFallback).toBe(false);
    const adsetPost = posts.find((p) => p.url.includes("/adsets"))!;
    const decoded = decodeURIComponent(adsetPost.url);
    expect(decoded).toContain('"cities":[{"key":"123"}]'); // sem "name" — só o key vai pra Meta
    expect(decoded).toContain('"age_min":35');
    // Slice 6: o snapshot preserva os interesses da fonte → apply reemite flexible_spec (cópia fiel).
    expect(decoded).toContain('"flexible_spec":[{"interests":[{"id":"i1"}]}]');
    // Slice 9: cópia reuse_adset de REMARKETING preserva os públicos salvos (antes virava frio).
    expect(decoded).toContain('"custom_audiences":[{"id":"ca1"}]');
    expect(decoded).toContain('"excluded_custom_audiences":[{"id":"ca2"}]');
    expect(decoded).toContain('"advantage_audience":0');
    expect(decoded).toContain('"custom_audience":0');
    expect(decoded).toContain('"lookalike":0');
  });

  it("geo VAZIO nunca vira geo_locations vazio → fallback país (Meta rejeita 'Falta uma localização')", async () => {
    const posts: Array<{ url: string }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => { posts.push({ url: String(input) }); return new Response(JSON.stringify({ id: "AS_NEW" }), { status: 200, headers: { "content-type": "application/json" } }); }));
    // explicit só com público salvo, sem geo → não pode sair geo_locations:{}
    await svc().createAdSet(account, { campaignId: "C", name: "A", dailyBudgetMinor: 1000, goal: "purchase", status: "paused", targeting: { kind: "explicit", geo: [], customAudienceIncludeIds: ["ca1"] } });
    // reuse com snapshot de geo NÃO-capturável (Advantage/custom_locations) → geo vazio no snapshot
    await svc().createAdSet(account, { campaignId: "C", name: "B", dailyBudgetMinor: 1000, goal: "purchase", status: "paused", targeting: { kind: "reuse_adset", sourceAdsetId: "AS", resolved: { geo: {}, expansionRaw: { advantageAudience: 0, relaxCustomAudience: 0, relaxLookalike: 0 } } } });
    const explicitPost = decodeURIComponent(posts.filter((p) => p.url.includes("/adsets"))[0]!.url);
    const reusePost = decodeURIComponent(posts.filter((p) => p.url.includes("/adsets"))[1]!.url);
    expect(explicitPost).toContain('"geo_locations":{"countries":["BR"]}');
    expect(reusePost).toContain('"geo_locations":{"countries":["BR"]}');
  });

  it("explicit com RAIO em REGIÃO → adapter faz STRIP (regions só {key}; raio é city-only)", async () => {
    const posts: Array<{ url: string }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        posts.push({ url: String(input) });
        return new Response(JSON.stringify({ id: "AS_NEW" }), { status: 200, headers: { "content-type": "application/json" } });
      }),
    );
    await svc().createAdSet(account, {
      campaignId: "CAMP1",
      name: "A",
      dailyBudgetMinor: 1000,
      goal: "purchase",
      targeting: {
        kind: "explicit",
        geo: [{ key: "MG", name: "Minas Gerais", kind: "region", radius: 30, distanceUnit: "kilometer" }],
      },
      status: "paused",
    });
    const decoded = decodeURIComponent(posts.find((p) => p.url.includes("/adsets"))!.url);
    expect(decoded).toContain('"regions":[{"key":"MG"}]'); // sem radius/distance_unit em região
    expect(decoded).not.toContain('"regions":[{"key":"MG","radius"');
  });

  it("explicit (Fase 1, subfatia 3a): monta geo por kind (país/região/cidade) + idade + gênero, expansão SEMPRE fechada", async () => {
    const posts: Array<{ url: string }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        posts.push({ url: String(input) });
        return new Response(JSON.stringify({ id: "AS_NEW" }), { status: 200, headers: { "content-type": "application/json" } });
      }),
    );
    await svc().createAdSet(account, {
      campaignId: "CAMP1",
      name: "A",
      dailyBudgetMinor: 1000,
      goal: "purchase",
      targeting: {
        kind: "explicit",
        geo: [
          { key: "BR", name: "Brasil", kind: "country" },
          { key: "123", name: "Belo Horizonte", kind: "city" },
        ],
        ageMin: 25,
        ageMax: 45,
        genders: [2],
      },
      status: "paused",
    });
    const decoded = decodeURIComponent(posts.find((p) => p.url.includes("/adsets"))!.url);
    expect(decoded).toContain('"countries":["BR"]');
    expect(decoded).toContain('"cities":[{"key":"123"}]');
    expect(decoded).toContain('"age_min":25');
    expect(decoded).toContain('"age_max":45');
    expect(decoded).toContain('"genders":[2]');
    expect(decoded).toContain('"advantage_audience":0');
    expect(decoded).toContain('"custom_audience":0');
    expect(decoded).toContain('"lookalike":0');
  });

  it("explicit com público salvo composto (geo + customAudienceIncludeIds no MESMO targeting)", async () => {
    const posts: Array<{ url: string }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        posts.push({ url: String(input) });
        return new Response(JSON.stringify({ id: "AS_NEW" }), { status: 200, headers: { "content-type": "application/json" } });
      }),
    );
    await svc().createAdSet(account, {
      campaignId: "CAMP1",
      name: "A",
      dailyBudgetMinor: 1000,
      goal: "purchase",
      targeting: {
        kind: "explicit",
        geo: [{ key: "123", name: "Belo Horizonte", kind: "city" }],
        customAudienceIncludeIds: ["ca_1"],
        customAudienceExcludeIds: ["ca_2"],
      },
      status: "paused",
    });
    const decoded = decodeURIComponent(posts.find((p) => p.url.includes("/adsets"))!.url);
    expect(decoded).toContain('"custom_audiences":[{"id":"ca_1"}]');
    expect(decoded).toContain('"excluded_custom_audiences":[{"id":"ca_2"}]');
    expect(decoded).toContain('"cities":[{"key":"123"}]');
  });

  it("explicit com 1 grupo de interesses → 1 objeto OR em flexible_spec", async () => {
    const posts: Array<{ url: string }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        posts.push({ url: String(input) });
        return new Response(JSON.stringify({ id: "AS_NEW" }), { status: 200, headers: { "content-type": "application/json" } });
      }),
    );
    await svc().createAdSet(account, {
      campaignId: "CAMP1",
      name: "A",
      dailyBudgetMinor: 1000,
      goal: "purchase",
      targeting: {
        kind: "explicit",
        geo: [{ key: "BR", name: "Brasil", kind: "country" }],
        interestGroups: [[{ id: "i1", name: "Estética" }, { id: "i2", name: "Beleza" }]],
      },
      status: "paused",
    });
    const decoded = decodeURIComponent(posts.find((p) => p.url.includes("/adsets"))!.url);
    expect(decoded).toContain('"flexible_spec":[{"interests":[{"id":"i1"},{"id":"i2"}]}]');
  });

  it("explicit com 2 grupos → AND narrowing (2 objetos em flexible_spec)", async () => {
    const posts: Array<{ url: string }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        posts.push({ url: String(input) });
        return new Response(JSON.stringify({ id: "AS_NEW" }), { status: 200, headers: { "content-type": "application/json" } });
      }),
    );
    await svc().createAdSet(account, {
      campaignId: "CAMP1",
      name: "A",
      dailyBudgetMinor: 1000,
      goal: "purchase",
      targeting: {
        kind: "explicit",
        geo: [{ key: "BR", name: "Brasil", kind: "country" }],
        interestGroups: [[{ id: "i1", name: "Estética" }], [{ id: "i2", name: "Beleza" }]],
      },
      status: "paused",
    });
    const decoded = decodeURIComponent(posts.find((p) => p.url.includes("/adsets"))!.url);
    expect(decoded).toContain('"flexible_spec":[{"interests":[{"id":"i1"}]},{"interests":[{"id":"i2"}]}]');
  });

  it("explicit com RAIO de cidade + área por endereço → cities[radius] + custom_locations", async () => {
    const posts: Array<{ url: string }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        posts.push({ url: String(input) });
        return new Response(JSON.stringify({ id: "AS_NEW" }), { status: 200, headers: { "content-type": "application/json" } });
      }),
    );
    await svc().createAdSet(account, {
      campaignId: "CAMP1",
      name: "A",
      dailyBudgetMinor: 1000,
      goal: "purchase",
      targeting: {
        kind: "explicit",
        geo: [{ key: "244661", name: "Belo Horizonte", kind: "city", radius: 25, distanceUnit: "kilometer" }],
        radiusAreas: [{ address: "Av. Afonso Pena 1500, BH", radius: 5, distanceUnit: "kilometer" }],
      },
      status: "paused",
    });
    const decoded = decodeURIComponent(posts.find((p) => p.url.includes("/adsets"))!.url).replace(/\+/g, " ");
    expect(decoded).toContain('"cities":[{"key":"244661","radius":25,"distance_unit":"kilometer"}]');
    expect(decoded).toContain('"custom_locations":[{"address_string":"Av. Afonso Pena 1500, BH","radius":5,"distance_unit":"kilometer"}]');
  });
});

describe("MetaCreationService.getAudienceProfile (P0.2/P1 — leitura isolada no propose)", () => {
  it("adset lível → devolve o AudienceProfile mapeado (não Record cru)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ targeting: { geo_locations: { cities: [{ key: "123", name: "Belo Horizonte" }] }, age_min: 35, age_max: 64 } }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
      ),
    );
    const profile = await svc().getAudienceProfile(account, "AS_WINNER");
    expect(profile).toMatchObject({ ageMin: 35, ageMax: 64, geoEntries: [{ key: "123", name: "Belo Horizonte", kind: "city" }] });
  });

  it("adset indisponível (erro/403/deletado) → null (caller decide bloquear, não herda às cegas)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: { message: "Unsupported get request", code: 100 } }), { status: 400, headers: { "content-type": "application/json" } })),
    );
    expect(await svc().getAudienceProfile(account, "AS_GONE")).toBeNull();
  });
});

/** Stub do /ads: devolve uma lista fixa de candidatos pra inferCreationDefaults. */
function stubAds(data: Record<string, unknown>[]) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify({ data }), { status: 200, headers: { "content-type": "application/json" } })),
  );
}

/** Extrai e parseia o `object_story_spec` (param na querystring do POST /adcreatives). */
function ossOf(url: string): Record<string, any> {
  const raw = new URL(url).searchParams.get("object_story_spec");
  return JSON.parse(raw ?? "{}");
}

/** Stub p/ createAdCreative: GET no vídeo (thumbnails) devolve a capa; POST /adcreatives devolve id. */
function stubCreativeGraph(coverUri: string | null) {
  const posts: Array<{ url: string }> = [];
  const spy = vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes("thumbnails")) {
      const data = coverUri ? [{ uri: coverUri, is_preferred: true }] : [];
      return new Response(JSON.stringify({ thumbnails: { data } }), { status: 200, headers: { "content-type": "application/json" } });
    }
    posts.push({ url });
    return new Response(JSON.stringify({ id: "CR1" }), { status: 200, headers: { "content-type": "application/json" } });
  });
  vi.stubGlobal("fetch", spy);
  return { posts: () => posts };
}

describe("MetaCreationService.createAdCreative — object_story_spec por formato de criativo", () => {
  const copy = { primaryText: "corpo", headline: "titulo", description: "desc", cta: "sign_up" as const };

  it("IMAGEM → link_data (name=headline, description, image_hash, cta com link)", async () => {
    const { posts } = stubCreativeGraph(null);
    const r = await svc().createAdCreative(account, {
      name: "cr img",
      pageId: "PAGE1",
      imageHash: "IMGHASH",
      linkUrl: "https://ex.com/lp",
      copy,
    });
    expect(r.creativeId).toBe("CR1");
    const oss = ossOf(posts().find((p) => p.url.includes("/adcreatives"))!.url);
    expect(oss.page_id).toBe("PAGE1");
    expect(oss.video_data).toBeUndefined();
    expect(oss.link_data).toMatchObject({
      message: "corpo",
      name: "titulo", // link_data usa `name` p/ o headline
      description: "desc",
      link: "https://ex.com/lp",
      image_hash: "IMGHASH",
    });
    expect(oss.link_data.call_to_action.type).toBe("SIGN_UP");
    expect(oss.link_data.call_to_action.value.link).toBe("https://ex.com/lp");
  });

  it("VÍDEO → video_data (title=headline, link_description, busca a capa do vídeo como image_url)", async () => {
    const { posts } = stubCreativeGraph("https://cover.jpg");
    await svc().createAdCreative(account, {
      name: "cr vid",
      pageId: "PAGE1",
      videoId: "VID1",
      linkUrl: "https://ex.com/lp",
      copy,
    });
    const oss = ossOf(posts().find((p) => p.url.includes("/adcreatives"))!.url);
    expect(oss.link_data).toBeUndefined();
    expect(oss.video_data).toMatchObject({
      video_id: "VID1",
      message: "corpo",
      title: "titulo", // video_data usa `title` (≠ link_data.name)
      link_description: "desc", // video_data usa `link_description` (≠ link_data.description)
      image_url: "https://cover.jpg", // capa obrigatória, buscada do vídeo
    });
    expect(oss.video_data.call_to_action.type).toBe("SIGN_UP");
  });

  it("VÍDEO com imageHash → usa a capa dada (image_hash) e NÃO busca thumbnail", async () => {
    const { posts } = stubCreativeGraph("https://cover.jpg");
    await svc().createAdCreative(account, { name: "cr", pageId: "PAGE1", videoId: "VID1", imageHash: "COVERHASH", copy });
    const oss = ossOf(posts().find((p) => p.url.includes("/adcreatives"))!.url);
    expect(oss.video_data.image_hash).toBe("COVERHASH");
    expect(oss.video_data.image_url).toBeUndefined();
  });

  it("VÍDEO sem capa disponível → cria mesmo assim, sem image_url (o caller decide)", async () => {
    const { posts } = stubCreativeGraph(null); // vídeo sem thumbnails
    await svc().createAdCreative(account, { name: "cr", pageId: "PAGE1", videoId: "VID1", copy });
    const oss = ossOf(posts().find((p) => p.url.includes("/adcreatives"))!.url);
    expect(oss.video_data.video_id).toBe("VID1");
    expect(oss.video_data.image_url).toBeUndefined();
    expect(oss.video_data.image_hash).toBeUndefined();
  });
});

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

  it("VÍDEO reusável → carrega a CAPA (video_data.image_hash) + o video_id (não depende de ler thumbnails, que pode dar #10)", async () => {
    stubAds([
      {
        id: "ADV",
        effective_status: "ACTIVE",
        creative: { object_story_spec: { page_id: "PAGE1", video_data: { video_id: "VID9", image_hash: "COVER9", call_to_action: { value: { link: "https://x.test" } } } } },
        adset: { id: "AS_V", promoted_object: { pixel_id: "PX9" } },
        campaign: { objective: "OUTCOME_LEADS" },
        insights: { data: [{ spend: "100", actions: [{ action_type: "lead", value: "5" }] }] },
      },
    ]);
    const r = await svc().inferCreationDefaults(account);
    expect(r.videoId).toBe("VID9");
    expect(r.imageHash).toBe("COVER9"); // a capa do vídeo (antes ficava ausente → apply falhava na Meta)
  });
});
