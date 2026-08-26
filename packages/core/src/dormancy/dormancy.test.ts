import { describe, expect, it } from "vitest";
import { evaluateDormancy, reactivationSignal, type DormancyInput } from "./index.js";

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_000 * DAY;

function base(over: Partial<DormancyInput> = {}): DormancyInput {
  return {
    hasActivity: false,
    currentState: "active",
    lastActivityAt: NOW - 2 * DAY,
    connectedAt: NOW - 30 * DAY,
    now: NOW,
    afterDays: 7,
    tokenValid: true,
    accountActive: true,
    ...over,
  };
}

describe("evaluateDormancy", () => {
  it("com atividade e ativa → refresh_activity (atualiza o relógio)", () => {
    expect(evaluateDormancy(base({ hasActivity: true })).kind).toBe("refresh_activity");
  });

  it("com atividade e dormante → reactivated", () => {
    expect(evaluateDormancy(base({ hasActivity: true, currentState: "dormant" })).kind).toBe("reactivated");
  });

  it("sem atividade dentro da graça → none", () => {
    expect(evaluateDormancy(base({ lastActivityAt: NOW - 3 * DAY })).kind).toBe("none");
  });

  it("sem atividade além de afterDays → went_dormant", () => {
    expect(evaluateDormancy(base({ lastActivityAt: NOW - 8 * DAY })).kind).toBe("went_dormant");
  });

  it("conta nova (last_activity_at null) usa a data de conexão como relógio (graça)", () => {
    expect(evaluateDormancy(base({ lastActivityAt: null, connectedAt: NOW - 3 * DAY })).kind).toBe("none");
    expect(evaluateDormancy(base({ lastActivityAt: null, connectedAt: NOW - 10 * DAY })).kind).toBe("went_dormant");
  });

  it("já dormante e sem atividade → none (não re-dispara)", () => {
    expect(evaluateDormancy(base({ currentState: "dormant", lastActivityAt: NOW - 30 * DAY })).kind).toBe("none");
  });

  it("token inválido ou conta não-active → excluída (none), mesmo parada há muito", () => {
    expect(evaluateDormancy(base({ tokenValid: false, lastActivityAt: NOW - 30 * DAY })).kind).toBe("none");
    expect(evaluateDormancy(base({ accountActive: false, lastActivityAt: NOW - 30 * DAY })).kind).toBe("none");
    // e não reativa uma conta com token inválido, mesmo vendo atividade.
    expect(evaluateDormancy(base({ tokenValid: false, hasActivity: true, currentState: "dormant" })).kind).toBe("none");
  });
});

describe("reactivationSignal", () => {
  it("é nível-conta, direção reactivated (sem baseline)", () => {
    const s = reactivationSignal("acc-1", "Loja X");
    expect(s.entityRef).toEqual({ level: "account", id: "acc-1", name: "Loja X" });
    expect(s.direction).toBe("reactivated");
    expect(s.metric).toBe("spend");
  });
});
