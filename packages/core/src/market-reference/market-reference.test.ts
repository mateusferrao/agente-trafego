import { describe, expect, it } from "vitest";
import type { MarketReference } from "@trafego/shared";
import { resolveMarketReference } from "./index.js";

const orgBRL: MarketReference = {
  currency: "BRL",
  cost: { conversation: { min: 3, max: 15 }, sale: { min: 40, max: 120 } },
  platform: { ctrBands: { ok: 1, good: 2, great: 3 }, frequencyAlert: 3 },
  operational: { zombieMinSpend: 50, minBaselineSpend: { low: 20, normal: 10, high: 5 } },
};

describe("resolveMarketReference", () => {
  it("aplica o org-default quando a moeda bate", () => {
    const r = resolveMarketReference(orgBRL, null, "BRL");
    expect(r.costTable).toEqual({ conversation: { min: 3, max: 15 }, sale: { min: 40, max: 120 } });
    expect(r.zombieMinSpend).toBe(50);
    expect(r.minBaselineSpend).toEqual({ low: 20, normal: 10, high: 5 });
    expect(r.ctrBands).toEqual({ ok: 1, good: 2, great: 3 });
  });

  it("descarta dinheiro do org quando a moeda NÃO bate (match-or-drop), mas mantém platform", () => {
    const r = resolveMarketReference(orgBRL, null, "USD");
    expect(r.costTable).toBeUndefined();
    expect(r.zombieMinSpend).toBeUndefined();
    expect(r.minBaselineSpend).toBeUndefined();
    // platform é agnóstico de moeda → segue.
    expect(r.ctrBands).toEqual({ ok: 1, good: 2, great: 3 });
    expect(r.frequencyAlert).toBe(3);
  });

  it("override por agente na moeda da conta vence o org campo a campo (merge)", () => {
    const agentUSD: MarketReference = { currency: "USD", cost: { sale: { min: 5, max: 20 } } };
    const r = resolveMarketReference(orgBRL, agentUSD, "USD");
    // org (BRL) não bate; só o custo de venda do agente (USD) entra.
    expect(r.costTable).toEqual({ sale: { min: 5, max: 20 } });
    // platform do org segue (sem moeda).
    expect(r.ctrBands).toEqual({ ok: 1, good: 2, great: 3 });
  });

  it("merge por campo: agente sobrescreve só a venda; conversa herda do org (mesma moeda)", () => {
    const agentBRL: MarketReference = { currency: "BRL", cost: { sale: { min: 60, max: 200 } } };
    const r = resolveMarketReference(orgBRL, agentBRL, "BRL");
    expect(r.costTable).toEqual({ conversation: { min: 3, max: 15 }, sale: { min: 60, max: 200 } });
  });

  it("moeda da conta nula → nenhum dinheiro casa; só platform", () => {
    const r = resolveMarketReference(orgBRL, null, null);
    expect(r.costTable).toBeUndefined();
    expect(r.zombieMinSpend).toBeUndefined();
    expect(r.ctrBands).toEqual({ ok: 1, good: 2, great: 3 });
  });

  it("sem org nem override → resolvido vazio", () => {
    expect(resolveMarketReference(null, null, "BRL")).toEqual({});
  });
});
