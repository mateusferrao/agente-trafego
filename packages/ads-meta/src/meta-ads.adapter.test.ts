import { afterEach, describe, expect, it, vi } from "vitest";
import type { Redis } from "ioredis";
import { MetaAdsAdapter } from "./meta-ads.adapter.js";
import { MetaGraphClient } from "./client.js";
import { AdsPlatformError } from "@trafego/shared/ports";
import { MetaGovernor } from "./governor.js";
import { MetaEntityCache } from "./entity-cache.js";

// O governor não é usado nos fluxos de onboarding (sem governor.acquire) — stub vazio.
const governor = {} as unknown as MetaGovernor;

function makeAdapter(): MetaAdsAdapter {
  const client = new MetaGraphClient({ graphVersion: "v26.0" });
  return new MetaAdsAdapter({ client, governor });
}

// Redis in-memory mínimo (set EX, get, del, pttl) p/ governor + cache de catálogo.
class FakeRedis {
  private store = new Map<string, { value: string; expiresAt: number | null }>();
  async set(key: string, value: string, mode?: string, ttlSec?: number): Promise<"OK"> {
    const expiresAt = mode === "EX" && ttlSec ? Date.now() + ttlSec * 1000 : null;
    this.store.set(key, { value, expiresAt });
    return "OK";
  }
  async get(key: string): Promise<string | null> {
    return this.store.get(key)?.value ?? null;
  }
  async del(...keys: string[]): Promise<number> {
    let n = 0;
    for (const k of keys) if (this.store.delete(k)) n++;
    return n;
  }
  async pttl(key: string): Promise<number> {
    const e = this.store.get(key);
    if (!e) return -2;
    if (e.expiresAt === null) return -1;
    const ms = e.expiresAt - Date.now();
    return ms > 0 ? ms : -2;
  }
}

// Adapter com governor real (rng 0 → backoff 0ms, sem flakiness) p/ testar rate-limit.
function makeAdapterWithGov(): { adapter: MetaAdsAdapter; gov: MetaGovernor } {
  const client = new MetaGraphClient({ graphVersion: "v26.0" });
  const gov = new MetaGovernor({ redis: new FakeRedis() as unknown as Redis, rng: () => 0 });
  return { adapter: new MetaAdsAdapter({ client, governor: gov }), gov };
}

interface StubbedResponse {
  readonly body: unknown;
  readonly status?: number;
  readonly headers?: Record<string, string>;
}

function stubFetchSequence(responses: readonly StubbedResponse[]) {
  const calls: string[] = [];
  let i = 0;
  const spy = vi.fn(async (input: string | URL | Request) => {
    calls.push(String(input));
    const r = responses[Math.min(i, responses.length - 1)]!;
    i += 1;
    return new Response(JSON.stringify(r.body), {
      status: r.status ?? 200,
      headers: { "content-type": "application/json", ...(r.headers ?? {}) },
    });
  });
  vi.stubGlobal("fetch", spy);
  return { calls: () => calls };
}

afterEach(() => vi.unstubAllGlobals());

describe("MetaAdsAdapter.listAccessibleAccounts", () => {
  it("agrega páginas e mapeia account_id/currency/business", async () => {
    const { calls } = stubFetchSequence([
      {
        body: {
          data: [{ account_id: "1", name: "Conta A", currency: "BRL", business: { id: "b1" } }],
          paging: { next: "https://graph.facebook.com/next", cursors: { after: "CURSOR2" } },
        },
      },
      { body: { data: [{ account_id: "2", name: "Conta B", currency: "USD" }], paging: {} } },
    ]);

    const accounts = await makeAdapter().listAccessibleAccounts("tok");

    expect(accounts).toEqual([
      { id: "1", name: "Conta A", currency: "BRL", businessId: "b1" },
      { id: "2", name: "Conta B", currency: "USD" },
    ]);
    // segunda chamada usa o cursor `after` da primeira página.
    expect(calls()).toHaveLength(2);
    expect(calls()[1]).toContain("after=CURSOR2");
  });

  it("uma página só (sem paging.next) → uma chamada", async () => {
    const { calls } = stubFetchSequence([{ body: { data: [{ account_id: "9", name: "X" }] } }]);
    const accounts = await makeAdapter().listAccessibleAccounts("tok");
    expect(accounts).toEqual([{ id: "9", name: "X" }]);
    expect(calls()).toHaveLength(1);
  });
});

describe("MetaAdsAdapter.getAdAccount", () => {
  it("busca uma conta pelo id (prefixa act_) e mapeia", async () => {
    const { calls } = stubFetchSequence([
      { body: { account_id: "123", name: "Conta X", currency: "BRL", business: { id: "b9" } } },
    ]);
    const account = await makeAdapter().getAdAccount("tok", "123");
    expect(account).toEqual({ id: "123", name: "Conta X", currency: "BRL", businessId: "b9" });
    expect(calls()[0]).toContain("act_123");
  });

  it("token sem posse da conta → AdsPlatformError (not_accessible)", async () => {
    stubFetchSequence([{ body: { error: { message: "não autorizado", code: 100 } }, status: 400 }]);
    await expect(makeAdapter().getAdAccount("tok", "999")).rejects.toMatchObject({
      name: "AdsPlatformError",
      kind: "not_accessible",
    });
    stubFetchSequence([{ body: { error: { message: "x", code: 100 } }, status: 400 }]);
    await expect(makeAdapter().getAdAccount("tok", "999")).rejects.toBeInstanceOf(AdsPlatformError);
  });

  it("rate-limit da Meta (code 17, HTTP 400) → rate_limited, não not_accessible", async () => {
    stubFetchSequence([{ body: { error: { message: "rate limit", code: 17 } }, status: 400 }]);
    await expect(makeAdapter().getAdAccount("tok", "1")).rejects.toMatchObject({
      name: "AdsPlatformError",
      kind: "rate_limited",
    });
  });

  it("erro com error_user_msg → AdsPlatformError carrega userMessage (mensagem legível repassada)", async () => {
    stubFetchSequence([
      {
        body: { error: { message: "Invalid parameter", code: 100, error_user_msg: "explicação legível pro usuário" } },
        status: 400,
      },
    ]);
    await expect(makeAdapter().getAdAccount("tok", "9")).rejects.toMatchObject({
      name: "AdsPlatformError",
      kind: "not_accessible",
      userMessage: "explicação legível pro usuário",
    });
  });
});

describe("MetaAdsAdapter.getAccountHealth (achado real, S — saúde da conta Meta)", () => {
  const ref = { adAccountId: "3218136031666639", accessToken: "tok" };

  it("mapeia a resposta real testada ao vivo contra a Meta (conta ativa, cartão de crédito)", async () => {
    const { calls } = stubFetchSequence([
      {
        body: {
          account_status: 1,
          disable_reason: 0,
          balance: "24432",
          amount_spent: "11311335",
          spend_cap: "0",
          funding_source_details: { display_string: "VISA *0835", type: 1, id: "26365591723126533" },
        },
      },
    ]);
    const { adapter } = makeAdapterWithGov();
    const health = await adapter.getAccountHealth(ref);
    expect(health.status).toBe("active");
    expect(health.balanceMajor).toBe(244.32);
    expect(health.amountSpentMajor).toBe(113113.35);
    expect(health.paymentMethodLabel).toBe("VISA *0835");
    expect(health.fundingType).toBe("other"); // cartão (type 1) — nunca stored_balance
    expect(health).not.toHaveProperty("disableReason");
    expect(health).not.toHaveProperty("spendCapMajor"); // "0" = sem teto, não R$ 0,00
    expect(calls()[0]).toContain("act_3218136031666639");
  });

  it("account_status desconhecido (código novo/indocumentado) → \"unknown\", nunca inventa", async () => {
    stubFetchSequence([{ body: { account_status: 999 } }]);
    const { adapter } = makeAdapterWithGov();
    const health = await adapter.getAccountHealth(ref);
    expect(health.status).toBe("unknown");
  });

  it("account_status desativada + disable_reason presente → status disabled, motivo honesto (não inventa o texto)", async () => {
    stubFetchSequence([{ body: { account_status: 2, disable_reason: 3 } }]);
    const { adapter } = makeAdapterWithGov();
    const health = await adapter.getAccountHealth(ref);
    expect(health.status).toBe("disabled");
    expect(health.disableReason).toBe("unknown_reason"); // só o código 0 (NONE) é conhecido com confiança
  });

  it("spend_cap real (> 0) → spendCapMajor preenchido", async () => {
    stubFetchSequence([{ body: { account_status: 1, spend_cap: "50000" } }]);
    const { adapter } = makeAdapterWithGov();
    const health = await adapter.getAccountHealth(ref);
    expect(health.spendCapMajor).toBe(500);
  });

  it("funding_source_details.type === 20 (STORED_BALANCE) → fundingType stored_balance", async () => {
    stubFetchSequence([{ body: { account_status: 1, funding_source_details: { type: 20 } } }]);
    const { adapter } = makeAdapterWithGov();
    const health = await adapter.getAccountHealth(ref);
    expect(health.fundingType).toBe("stored_balance");
  });

  it("sem funding_source_details → paymentMethodLabel/fundingType ausentes (não força null)", async () => {
    stubFetchSequence([{ body: { account_status: 1 } }]);
    const { adapter } = makeAdapterWithGov();
    const health = await adapter.getAccountHealth(ref);
    expect(health).not.toHaveProperty("paymentMethodLabel");
    expect(health).not.toHaveProperty("fundingType");
  });

  it("cooldown ativo → degrada (rate_limited) sem bater na Meta", async () => {
    const { adapter, gov } = makeAdapterWithGov();
    await gov.observeUsage("act_3218136031666639", {
      callCountPct: 100,
      totalCputimePct: 50,
      totalTimePct: 50,
      estimatedTimeToRegainAccessMin: 5,
    });
    const { calls } = stubFetchSequence([{ body: { account_status: 1 } }]);
    await expect(adapter.getAccountHealth(ref)).rejects.toMatchObject({
      name: "AdsPlatformError",
      kind: "rate_limited",
    });
    expect(calls().length).toBe(0);
  });
});

describe("MetaAdsAdapter.listEntities (governor)", () => {
  const ref = { adAccountId: "1", accessToken: "tok" };
  const usageHeader = JSON.stringify({ act_1: [{ call_count: 30, total_cputime: 10, total_time: 10 }] });

  it("S2: mapeia bid_strategy/bid_amount (cru da Meta → BidStrategy neutra + major currency)", async () => {
    stubFetchSequence([
      {
        body: {
          data: [
            { id: "c1", name: "Camp CBO", status: "ACTIVE", objective: "OUTCOME_SALES", bid_strategy: "LOWEST_COST_WITH_BID_CAP", bid_amount: "500" },
            { id: "c2", name: "Camp sem cap", status: "ACTIVE", objective: "OUTCOME_SALES", bid_strategy: "LOWEST_COST_WITHOUT_CAP" },
          ],
        },
      },
    ]);
    const { adapter } = makeAdapterWithGov();
    const entities = await adapter.listEntities(ref, "campaign");
    expect(entities.find((e) => e.id === "c1")).toMatchObject({ bidStrategy: "bid_cap", bidCapMajor: 5 });
    expect(entities.find((e) => e.id === "c2")).toMatchObject({ bidStrategy: "lowest_cost" });
    expect(entities.find((e) => e.id === "c2")).not.toHaveProperty("bidCapMajor");
  });

  it("S2: bid_strategy desconhecido/ausente → bidStrategy undefined (honesto, não inventa)", async () => {
    stubFetchSequence([{ body: { data: [{ id: "c1", name: "Camp", status: "ACTIVE", objective: "OUTCOME_SALES", bid_strategy: "SOME_FUTURE_ENUM" }] } }]);
    const { adapter } = makeAdapterWithGov();
    const entities = await adapter.listEntities(ref, "campaign");
    expect(entities[0]).not.toHaveProperty("bidStrategy");
  });

  it("S2 (achado da revisão): bid_amount SEM bidStrategy reconhecido/≠lowest_cost → bidCapMajor omitido (nunca solto/contraditório)", async () => {
    stubFetchSequence([
      { body: { data: [{ id: "c1", name: "Camp enum futuro", status: "ACTIVE", objective: "OUTCOME_SALES", bid_strategy: "SOME_FUTURE_ENUM", bid_amount: "500" }] } },
    ]);
    const { adapter } = makeAdapterWithGov();
    const entities = await adapter.listEntities(ref, "campaign");
    expect(entities[0]).not.toHaveProperty("bidCapMajor");
  });

  it("rate-limit transitório (code 17) → retry inline → completa", async () => {
    const { calls } = stubFetchSequence([
      { body: { error: { message: "throttled", code: 17 } }, status: 400 },
      { body: { data: [{ id: "c1", name: "Camp", status: "ACTIVE", objective: "OUTCOME_SALES" }] } },
    ]);
    const { adapter } = makeAdapterWithGov();
    const entities = await adapter.listEntities(ref, "campaign");
    expect(entities.map((e) => e.id)).toEqual(["c1"]);
    expect(calls().length).toBe(2); // 1ª falhou (rate-limit), retry completou
  });

  it("cooldown ativo → degrada (rate_limited) sem bater na Meta", async () => {
    const { adapter, gov } = makeAdapterWithGov();
    await gov.observeUsage("act_1", {
      callCountPct: 100,
      totalCputimePct: 50,
      totalTimePct: 50,
      estimatedTimeToRegainAccessMin: 5,
    });
    const { calls } = stubFetchSequence([{ body: { data: [] } }]);
    await expect(adapter.listEntities(ref, "campaign")).rejects.toMatchObject({
      name: "AdsPlatformError",
      kind: "rate_limited",
    });
    expect(calls().length).toBe(0); // cooldown → nem chega a chamar fetch
  });

  it("sucesso alimenta o governor (observeUsage do header BUC)", async () => {
    const { adapter, gov } = makeAdapterWithGov();
    const spy = vi.spyOn(gov, "observeUsage");
    stubFetchSequence([
      {
        body: { data: [{ id: "c1", name: "Camp", status: "ACTIVE", objective: "OUTCOME_SALES" }] },
        headers: { "x-business-use-case-usage": usageHeader },
      },
    ]);
    await adapter.listEntities(ref, "campaign");
    expect(spy).toHaveBeenCalledWith("act_1", expect.objectContaining({ callCountPct: 30 }));
  });
});

describe("MetaAdsAdapter.listEntities (statusFilter — S7-sync, achado real: rate-limit em conta grande)", () => {
  const ref = { adAccountId: "1", accessToken: "tok" };

  it("sem opts → NÃO manda o PARÂMETRO effective_status (o campo 'effective_status' em fields= é outra coisa; catálogo completo, o chat depende disso)", async () => {
    const { calls } = stubFetchSequence([{ body: { data: [{ id: "c1", name: "Camp", status: "PAUSED", objective: "OUTCOME_SALES" }] } }]);
    const { adapter } = makeAdapterWithGov();
    await adapter.listEntities(ref, "adset");
    const params = new URL(calls()[0]!).searchParams;
    expect(params.has("effective_status")).toBe(false);
  });

  it("statusFilter:'active' → manda o parâmetro effective_status=[\"ACTIVE\"] na chamada", async () => {
    const { calls } = stubFetchSequence([{ body: { data: [] } }]);
    const { adapter } = makeAdapterWithGov();
    await adapter.listEntities(ref, "adset", { statusFilter: "active" });
    const params = new URL(calls()[0]!).searchParams;
    expect(params.get("effective_status")).toBe('["ACTIVE"]');
  });

  it("statusFilter:'active' NÃO usa nem alimenta o cache de catálogo (não contamina o completo que o chat lê)", async () => {
    const client = new MetaGraphClient({ graphVersion: "v26.0" });
    const redis = new FakeRedis() as unknown as Redis;
    const gov = new MetaGovernor({ redis, rng: () => 0 });
    const entityCache = new MetaEntityCache({ redis, ttlSec: 600 });
    const adapter = new MetaAdsAdapter({ client, governor: gov, entityCache });

    stubFetchSequence([{ body: { data: [{ id: "a1", name: "Adset ativo", status: "ACTIVE", objective: "OUTCOME_SALES" }] } }]);
    await adapter.listEntities(ref, "adset", { statusFilter: "active" }); // não deve cachear
    expect(await entityCache.get("act_1", "adset")).toBeNull();

    // chamada seguinte SEM filtro é um MISS de verdade (bateu na Meta de novo, não leu um cache poluído)
    const { calls } = stubFetchSequence([{ body: { data: [{ id: "a1", name: "Adset (completo)", status: "ACTIVE", objective: "OUTCOME_SALES" }, { id: "a2", name: "Adset pausado", status: "PAUSED", objective: "OUTCOME_SALES" }] } }]);
    const full = await adapter.listEntities(ref, "adset");
    expect(calls().length).toBe(1);
    expect(full.map((e) => e.id).sort()).toEqual(["a1", "a2"]);
  });
});

describe("MetaAdsAdapter.listEntities (cache de catálogo)", () => {
  const ref = { adAccountId: "1", accessToken: "tok" };

  function makeAdapterWithCache() {
    const client = new MetaGraphClient({ graphVersion: "v26.0" });
    const redis = new FakeRedis() as unknown as Redis;
    const gov = new MetaGovernor({ redis, rng: () => 0 });
    const entityCache = new MetaEntityCache({ redis, ttlSec: 600 });
    return { adapter: new MetaAdsAdapter({ client, governor: gov, entityCache }), entityCache };
  }

  it("2ª chamada usa o cache (não bate na Meta)", async () => {
    const { calls } = stubFetchSequence([
      { body: { data: [{ id: "c1", name: "Camp", status: "ACTIVE", objective: "OUTCOME_SALES" }] } },
    ]);
    const { adapter } = makeAdapterWithCache();
    const a = await adapter.listEntities(ref, "campaign"); // miss → lista + cacheia
    const b = await adapter.listEntities(ref, "campaign"); // hit → sem fetch
    expect(a).toEqual(b);
    expect(calls().length).toBe(1); // só a 1ª bateu na Meta
  });

  it("escrita real invalida o catálogo (re-lista na próxima)", async () => {
    stubFetchSequence([
      { body: { data: [{ id: "c1", name: "Camp", status: "ACTIVE" }] } }, // list 1
      { body: { status: "ACTIVE" } }, // readEntityState do mutate
      { body: { success: true } }, // POST pause
      { body: { data: [{ id: "c1", name: "Camp", status: "PAUSED" }] } }, // list 2 (pós-invalidação)
    ]);
    const { adapter } = makeAdapterWithCache();
    await adapter.listEntities(ref, "campaign"); // cacheia
    await adapter.mutate(ref, {
      id: "a1", type: "pause_entity", target: { level: "campaign", id: "c1" },
      params: {}, source: "playbook", riskLevel: "low", reason: "t",
    });
    const after = await adapter.listEntities(ref, "campaign"); // cache invalidado → re-lista
    expect(after[0]?.status).toBe("paused");
  });

  it("dry-run NÃO invalida (nada mudou)", async () => {
    const { calls } = stubFetchSequence([
      { body: { data: [{ id: "c1", name: "Camp", status: "ACTIVE" }] } }, // list
      { body: { status: "ACTIVE", daily_budget: "10000" } }, // readEntityState (dry-run)
    ]);
    const { adapter } = makeAdapterWithCache();
    await adapter.listEntities(ref, "campaign");
    await adapter.mutate(
      ref,
      { id: "a1", type: "adjust_budget", target: { level: "campaign", id: "c1" }, params: { mode: "decrease", pct: 10 }, source: "playbook", riskLevel: "low", reason: "t" },
      { dryRun: true },
    );
    await adapter.listEntities(ref, "campaign"); // ainda cacheado (dry-run não invalidou)
    // chamadas: list(1) + readEntityState(1) = 2; a 2ª listEntities veio do cache.
    expect(calls().length).toBe(2);
  });
});

describe("readActivationTree (ativação em cadeia + entrega efetiva)", () => {
  const ref = { adAccountId: "1", accessToken: "tok" };

  it("campanha → conjuntos + anúncios com status EFETIVO (anúncio sob adset pausado = paused)", async () => {
    const { adapter } = makeAdapterWithGov();
    stubFetchSequence([
      { body: { data: [
        { id: "a1", name: "Ad 1", effective_status: "ACTIVE", adset_id: "s1" },
        { id: "a2", name: "Ad 2", effective_status: "ADSET_PAUSED", adset_id: "s2" },
      ] } },
      { body: { data: [
        { id: "s1", name: "Set 1", effective_status: "ACTIVE" },
        { id: "s2", name: "Set 2", effective_status: "PAUSED" },
      ] } },
    ]);
    const tree = await adapter.readActivationTree(ref, "campaign", "c1");
    expect(tree.ads).toEqual([
      { id: "a1", name: "Ad 1", status: "active", adsetId: "s1" },
      { id: "a2", name: "Ad 2", status: "paused", adsetId: "s2" },
    ]);
    expect(tree.adsets).toEqual([
      { id: "s1", name: "Set 1", status: "active" },
      { id: "s2", name: "Set 2", status: "paused" },
    ]);
  });

  it("conjunto → só anúncios (sem sub-conjunto, sem 2ª chamada)", async () => {
    const { adapter } = makeAdapterWithGov();
    const { calls } = stubFetchSequence([
      { body: { data: [{ id: "a1", name: "Ad 1", effective_status: "ACTIVE", adset_id: "s1" }] } },
    ]);
    const tree = await adapter.readActivationTree(ref, "adset", "s1");
    expect(tree.adsets).toEqual([]);
    expect(tree.ads).toEqual([{ id: "a1", name: "Ad 1", status: "active", adsetId: "s1" }]);
    expect(calls().length).toBe(1); // só /ads
  });
});
