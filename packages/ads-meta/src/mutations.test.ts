import { afterEach, describe, expect, it, vi } from "vitest";
import type { Action } from "@trafego/shared/types";
import { MetaGraphClient } from "./client.js";
import { MetaMutationsService } from "./mutations.js";

const account = { adAccountId: "123", accessToken: "tok" };

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
});
