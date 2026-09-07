import { afterEach, describe, expect, it, vi } from "vitest";
import type { Action, TargetingSpec } from "@trafego/shared/types";
import { ACTION_PARAM_TARGETING } from "@trafego/shared";
import { MetaGraphClient } from "./client.js";
import { MetaMutationsService } from "./mutations.js";

const account = { adAccountId: "123", accessToken: "tok" };

/** `TargetingSpec.explicit` mínimo (só geo) — público resolvido nome→id da proposta. */
function explicitSpec(over: Partial<Extract<TargetingSpec, { kind: "explicit" }>> = {}): TargetingSpec {
  return { kind: "explicit", geo: [{ key: "BR", name: "Brasil", kind: "country" }], ...over };
}

/** Roteia por (método, path-suffix): GET lê estado; POST é a escrita. */
function stubGraph(state: Record<string, unknown>) {
  const posts: Array<{ url: string }> = [];
  const spy = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if ((init?.method ?? "GET") === "POST") {
      posts.push({ url });
      return new Response(JSON.stringify({ success: true }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify(state), { status: 200, headers: { "content-type": "application/json" } });
  });
  vi.stubGlobal("fetch", spy);
  return { posts: () => posts };
}

afterEach(() => vi.unstubAllGlobals());

function svc() {
  return new MetaMutationsService(new MetaGraphClient({ graphVersion: "v26.0" }));
}

function act(type: Action["type"], over: Partial<Action> = {}): Action {
  return {
    id: "a1",
    type,
    target: { level: "campaign", id: "C1" },
    params: {},
    source: "playbook",
    riskLevel: "low",
    reason: "test",
    ...over,
  };
}

describe("MetaMutationsService", () => {
  it("pause: escreve status=PAUSED e retorna before/after", async () => {
    const { posts } = stubGraph({ status: "ACTIVE", effective_status: "ACTIVE" });
    const res = await svc().mutate(account, act("pause_entity"));
    expect(posts()).toHaveLength(1);
    expect(posts()[0]!.url).toContain("status=PAUSED");
    expect(res.before["status"]).toBe("ACTIVE");
    expect(res.after["status"]).toBe("PAUSED");
  });

  it("pause idempotente: já PAUSED → no-op (before==after, sem POST)", async () => {
    const { posts } = stubGraph({ status: "PAUSED" });
    const res = await svc().mutate(account, act("pause_entity"));
    expect(posts()).toHaveLength(0);
    expect(res.after["status"]).toBe("PAUSED");
  });

  it("resume: escreve status=ACTIVE", async () => {
    const { posts } = stubGraph({ status: "PAUSED" });
    await svc().mutate(account, act("resume_entity"));
    expect(posts()[0]!.url).toContain("status=ACTIVE");
  });

  it("resume de ANÚNCIO: before-read NÃO pede budget (ad não tem → evita Meta #100)", async () => {
    const gets: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if ((init?.method ?? "GET") === "GET") gets.push(url);
        return new Response(JSON.stringify({ status: "PAUSED", effective_status: "PAUSED" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }),
    );
    await svc().mutate(account, act("resume_entity", { target: { level: "ad", id: "AD1" } }));
    expect(gets[0]).toContain("fields=status%2Ceffective_status"); // sem daily_budget/lifetime_budget
    expect(gets[0]).not.toContain("daily_budget");
  });

  it("resume de CAMPANHA: before-read ainda pede budget (drift de CBO)", async () => {
    const gets: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if ((init?.method ?? "GET") === "GET") gets.push(url);
        return new Response(JSON.stringify({ status: "PAUSED" }), { status: 200, headers: { "content-type": "application/json" } });
      }),
    );
    await svc().mutate(account, act("resume_entity", { target: { level: "campaign", id: "C1" } }));
    expect(gets[0]).toContain("daily_budget");
  });

  it("adjust_budget decrease 20%: aplica sobre o daily_budget (minor units)", async () => {
    const { posts } = stubGraph({ status: "ACTIVE", daily_budget: "10000" }); // R$100,00
    const res = await svc().mutate(
      account,
      act("adjust_budget", { params: { mode: "decrease", pct: 20 } }),
    );
    // 10000 * 0.8 = 8000
    expect(posts()[0]!.url).toContain("daily_budget=8000");
    expect(res.after["daily_budget"]).toBe("8000");
  });

  it("adjust_budget increase 10% em lifetime quando não há daily", async () => {
    const { posts } = stubGraph({ status: "ACTIVE", lifetime_budget: "50000" });
    await svc().mutate(account, act("adjust_budget", { params: { mode: "increase", pct: 10 } }));
    expect(posts()[0]!.url).toContain("lifetime_budget=55000");
  });

  it("adjust_budget respeita o piso mínimo (não desce abaixo de MIN)", async () => {
    const { posts } = stubGraph({ status: "ACTIVE", daily_budget: "120" });
    await svc().mutate(account, act("adjust_budget", { params: { mode: "decrease", pct: 90 } }));
    // 120 * 0.1 = 12 → piso 100
    expect(posts()[0]!.url).toContain("daily_budget=100");
  });

  it("adjust_budget set: aplica valor ABSOLUTO exato (minor units)", async () => {
    const { posts } = stubGraph({ status: "ACTIVE", daily_budget: "10000" });
    const res = await svc().mutate(account, act("adjust_budget", { params: { mode: "set", amountMinor: 20000 } }));
    expect(posts()[0]!.url).toContain("daily_budget=20000");
    expect(res.after["daily_budget"]).toBe("20000");
  });

  it("adjust_budget set idempotente: já no valor alvo → no-op (sem POST)", async () => {
    const { posts } = stubGraph({ status: "ACTIVE", daily_budget: "20000" });
    const res = await svc().mutate(account, act("adjust_budget", { params: { mode: "set", amountMinor: 20000 } }));
    expect(posts()).toHaveLength(0);
    expect(res.after["daily_budget"]).toBe("20000");
  });

  it("adjust_budget set respeita o piso mínimo", async () => {
    const { posts } = stubGraph({ status: "ACTIVE", daily_budget: "10000" });
    await svc().mutate(account, act("adjust_budget", { params: { mode: "set", amountMinor: 50 } }));
    expect(posts()[0]!.url).toContain("daily_budget=100"); // piso MIN
  });

  it("adjust_budget set aplica no lifetime quando não há daily", async () => {
    const { posts } = stubGraph({ status: "ACTIVE", lifetime_budget: "50000" });
    await svc().mutate(account, act("adjust_budget", { params: { mode: "set", amountMinor: 60000 } }));
    expect(posts()[0]!.url).toContain("lifetime_budget=60000");
  });

  it("set_status: aplica o status dos params", async () => {
    const { posts } = stubGraph({ status: "ACTIVE" });
    await svc().mutate(account, act("set_status", { params: { status: "PAUSED" } }));
    expect(posts()[0]!.url).toContain("status=PAUSED");
  });

  it("restoreEntityState (undo): reaplica status + budget absolutos do before", async () => {
    const { posts } = stubGraph({ status: "ACTIVE", daily_budget: "8000" }); // estado atual
    const res = await svc().restoreEntityState(account, "C1", { status: "PAUSED", daily_budget: "10000" });
    expect(posts()[0]!.url).toContain("status=PAUSED");
    expect(posts()[0]!.url).toContain("daily_budget=10000");
    expect(res.before["daily_budget"]).toBe("8000");
    expect(res.after["daily_budget"]).toBe("10000");
  });

  it("dry_run: computa before/after mas NÃO escreve (ensaio)", async () => {
    const { posts } = stubGraph({ status: "ACTIVE", daily_budget: "10000" });
    const res = await svc().mutate(
      account,
      act("adjust_budget", { params: { mode: "decrease", pct: 20 } }),
      { dryRun: true },
    );
    expect(posts()).toHaveLength(0); // não escreveu
    expect(res.before["daily_budget"]).toBe("10000");
    expect(res.after["daily_budget"]).toBe("8000"); // mostra o que aconteceria
  });

  // ── adjust_audience (Fatia C): escreve `targeting` cru do adset ──

  it("adjust_audience: escreve targeting serializado + before/after carregam o público", async () => {
    const { posts } = stubGraph({ status: "ACTIVE", targeting: { geo_locations: { countries: ["US"] } } });
    const res = await svc().mutate(
      account,
      act("adjust_audience", {
        target: { level: "adset", id: "AS1" },
        params: { [ACTION_PARAM_TARGETING]: explicitSpec() },
      }),
    );
    expect(posts()).toHaveLength(1);
    // targeting vai como 1 campo JSON (URL-encoded) com o país proposto (BR).
    expect(decodeURIComponent(posts()[0]!.url)).toContain('"countries":["BR"]');
    expect((res.before["targeting"] as { geo_locations: { countries: string[] } }).geo_locations.countries).toEqual(["US"]);
    expect((res.after["targeting"] as { geo_locations: { countries: string[] } }).geo_locations.countries).toEqual(["BR"]);
  });

  it("adjust_audience before-read pede o campo targeting (revert fiel)", async () => {
    const gets: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if ((init?.method ?? "GET") === "GET") gets.push(url);
        return new Response(JSON.stringify({ status: "ACTIVE", targeting: {} }), { status: 200, headers: { "content-type": "application/json" } });
      }),
    );
    await svc().mutate(account, act("adjust_audience", { target: { level: "adset", id: "AS1" }, params: { [ACTION_PARAM_TARGETING]: explicitSpec() } }));
    expect(gets[0]).toContain("targeting");
  });

  it("adjust_audience SEMPRE escreve (substituição total; sem falso no-op) — mesmo público igual ao atual", async () => {
    // público atual == proposto (BR). Como é substituição total + human-gated, escrevemos mesmo assim
    // (o executor dedupa reaplicações exatas por idempotency_key; um no-op aqui seria frágil/incorreto).
    const { posts } = stubGraph({ status: "ACTIVE", targeting: { geo_locations: { countries: ["BR"] }, targeting_automation: { advantage_audience: 0 }, targeting_relaxation_types: { custom_audience: 0, lookalike: 0 } } });
    const res = await svc().mutate(account, act("adjust_audience", { target: { level: "adset", id: "AS1" }, params: { [ACTION_PARAM_TARGETING]: explicitSpec() } }));
    expect(posts()).toHaveLength(1);
    expect((res.after["targeting"] as { geo_locations: { countries: string[] } }).geo_locations.countries).toEqual(["BR"]);
  });

  it("adjust_audience: REMOVER uma dimensão (tirar filtro de gênero) escreve de verdade (não é falso no-op)", async () => {
    // atual restringe gênero; proposto = 'todos' (explicit SEM genders). Um subset-match daria falso
    // no-op (a chave removida some do proposto) e manteria o filtro antigo — aqui garantimos o POST.
    const { posts } = stubGraph({ status: "ACTIVE", targeting: { geo_locations: { countries: ["BR"] }, genders: [1], targeting_automation: { advantage_audience: 0 }, targeting_relaxation_types: { custom_audience: 0, lookalike: 0 } } });
    await svc().mutate(account, act("adjust_audience", { target: { level: "adset", id: "AS1" }, params: { [ACTION_PARAM_TARGETING]: explicitSpec() } }));
    expect(posts()).toHaveLength(1);
    const url = decodeURIComponent(posts()[0]!.url);
    expect(url).not.toContain('"genders"'); // o público proposto não tem gênero → o filtro sai
  });

  it("adjust_audience sem público explícito nos params → erro (o worker deveria ter resolvido)", async () => {
    stubGraph({ status: "ACTIVE", targeting: {} });
    await expect(
      svc().mutate(account, act("adjust_audience", { target: { level: "adset", id: "AS1" }, params: {} })),
    ).rejects.toThrow(/público explícito/);
  });

  it("adjust_audience dry_run: computa o after mas NÃO escreve", async () => {
    const { posts } = stubGraph({ status: "ACTIVE", targeting: { geo_locations: { countries: ["US"] } } });
    const res = await svc().mutate(
      account,
      act("adjust_audience", { target: { level: "adset", id: "AS1" }, params: { [ACTION_PARAM_TARGETING]: explicitSpec() } }),
      { dryRun: true },
    );
    expect(posts()).toHaveLength(0);
    expect((res.after["targeting"] as { geo_locations: { countries: string[] } }).geo_locations.countries).toEqual(["BR"]);
  });

  it("restoreEntityState (undo de adjust_audience): reescreve o targeting cru anterior", async () => {
    const { posts } = stubGraph({ status: "ACTIVE", targeting: { geo_locations: { countries: ["BR"] } } }); // estado atual (novo)
    const res = await svc().restoreEntityState(account, "AS1", { status: "ACTIVE", targeting: { geo_locations: { countries: ["US"] } } });
    expect(decodeURIComponent(posts()[0]!.url)).toContain('"countries":["US"]'); // volta o público antigo
    // after.targeting vem serializado (string), igual ao budget no restore — o POST é a prova do undo.
    expect(JSON.parse(res.after["targeting"] as string).geo_locations.countries).toEqual(["US"]);
  });
});
