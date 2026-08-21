import { describe, expect, it, vi } from "vitest";
import type { Action, GuardrailConfig } from "@trafego/shared/types";
import type { MutationResult } from "@trafego/shared/ports";
import { applyCheckedAction } from "./apply-confirmed-action.js";

const pause: Action = {
  id: "a1",
  type: "pause_entity",
  target: { level: "campaign", id: "C1" },
  params: {},
  source: "llm",
  riskLevel: "low",
  reason: "test",
};

const budget: Action = {
  id: "a2",
  type: "adjust_budget",
  target: { level: "campaign", id: "C2" },
  params: { mode: "increase", pct: 90 },
  source: "llm",
  riskLevel: "medium",
  reason: "test",
};

function cfg(over: Partial<GuardrailConfig> = {}): GuardrailConfig {
  return {
    maxBudgetChangePct: 20,
    maxEntitiesPerDay: 10,
    allowedActions: ["pause_entity", "resume_entity", "set_status", "adjust_budget"],
    dryRun: false,
    killSwitch: false,
    ...over,
  };
}

/** executor fake: devolve um MutationResult controlável. */
function fakeExecutor(result: MutationResult, opts?: { dryRun?: boolean; throws?: boolean }) {
  const execute = vi.fn(async (input: { dryRun: boolean; action: Action }) => {
    if (opts?.throws) throw new Error("meta down");
    return { result, dryRun: opts?.dryRun ?? input.dryRun, replayed: false };
  });
  return { executor: { execute }, execute };
}

const base = {
  account: { adAccountId: "act_1", accessToken: "tok" },
  runId: "run1",
  orgId: "org1",
  idempotencyKey: "k1",
};

describe("applyCheckedAction", () => {
  it("guardrail barra (tipo não permitido) → blocked com motivo, sem executar", async () => {
    const { executor, execute } = fakeExecutor({ action: pause, before: {}, after: {} });
    const out = await applyCheckedAction({
      ...base,
      executor,
      action: pause,
      cfg: cfg({ allowedActions: ["resume_entity"] }),
      ctx: {},
    });
    expect(out.kind).toBe("blocked");
    if (out.kind === "blocked") expect(out.reason).toContain("não permitida");
    expect(execute).not.toHaveBeenCalled();
  });

  it("escrita real (before≠after) → applied", async () => {
    const { executor } = fakeExecutor({ action: pause, before: { status: "ACTIVE" }, after: { status: "PAUSED" } });
    const out = await applyCheckedAction({ ...base, executor, action: pause, cfg: cfg(), ctx: {} });
    expect(out.kind).toBe("applied");
    if (out.kind === "applied") expect(out.dryRun).toBe(false);
  });

  it("no-op (before==after em escrita real) → noop", async () => {
    const same = { status: "PAUSED" };
    const { executor } = fakeExecutor({ action: pause, before: same, after: same });
    const out = await applyCheckedAction({ ...base, executor, action: pause, cfg: cfg(), ctx: {} });
    expect(out.kind).toBe("noop");
  });

  it("dry-run (cfg.dryRun) → applied com dryRun=true mesmo com before==after", async () => {
    const same = { status: "ACTIVE" };
    const { executor, execute } = fakeExecutor({ action: pause, before: same, after: same }, { dryRun: true });
    const out = await applyCheckedAction({ ...base, executor, action: pause, cfg: cfg({ dryRun: true }), ctx: {} });
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({ dryRun: true }));
    expect(out.kind).toBe("applied");
    if (out.kind === "applied") expect(out.dryRun).toBe(true);
  });

  it("executor lança (Meta caiu) → failed, sem propagar", async () => {
    const { executor } = fakeExecutor({ action: pause, before: {}, after: {} }, { throws: true });
    const out = await applyCheckedAction({ ...base, executor, action: pause, cfg: cfg(), ctx: {} });
    expect(out.kind).toBe("failed");
  });

  it("clampa o % de budget ao teto e executa a versão clampada", async () => {
    const { executor, execute } = fakeExecutor({ action: budget, before: { daily_budget: "10000" }, after: { daily_budget: "12000" } });
    await applyCheckedAction({ ...base, executor, action: budget, cfg: cfg({ maxBudgetChangePct: 20 }), ctx: {} });
    const passed = execute.mock.calls[0]![0] as { action: Action };
    expect(passed.action.params["pct"]).toBe(20); // 90 → clampado a 20
  });
});
