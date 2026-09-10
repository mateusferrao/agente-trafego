import { describe, expect, it, vi } from "vitest";
import type { GuardrailContext } from "@trafego/core";
import { ACTION_PARAM_AMOUNT_MINOR, ACTION_PARAM_MODE, BUDGET_MODE_SET } from "@trafego/shared";
import type { Action } from "@trafego/shared/types";
import type { ApplyResult } from "./apply-confirmed-action.js";
import { runReallocationSaga, type ApplyLeg } from "./reallocation-saga.js";

const budget = (id: string, name: string, amountMinor: number): Action => ({
  id: `${id}-tc`,
  type: "adjust_budget",
  target: { level: "campaign", id, name },
  params: { [ACTION_PARAM_MODE]: BUDGET_MODE_SET, [ACTION_PARAM_AMOUNT_MINOR]: amountMinor },
  source: "llm",
  riskLevel: "medium",
  reason: "realocação",
});

const legFrom = budget("A", "Campanha A", 8000); // A cai pra 80
const legTo = budget("B", "Campanha B", 7200); // B sobe pra 72
const saga = { sourceKey: "campaign:A", sourceRestoreMinor: 10000 }; // A tinha 100

const applied = (action: Action): ApplyResult => ({ kind: "applied", dryRun: false, result: { action, before: {}, after: {} }, action });
const blocked = (action: Action, reason = "barrada"): ApplyResult => ({ kind: "blocked", reason, action });
const failed = (action: Action): ApplyResult => ({ kind: "failed", error: new Error("meta down"), action });

const baseCtx: GuardrailContext = { touchedToday: new Set<string>(), budgetAmountByEntity: new Map([["campaign:A", 10000], ["campaign:B", 6000]]) };

describe("runReallocationSaga (A4 — saga com compensação)", () => {
  it("as duas pernas aplicam → done", async () => {
    const applyLeg: ApplyLeg = vi.fn(async (a) => applied(a));
    const out = await runReallocationSaga(legFrom, legTo, saga, baseCtx, applyLeg);
    expect(out.kind).toBe("done");
    expect(applyLeg).toHaveBeenCalledTimes(2); // origem + destino, SEM compensação
  });

  it("origem falha → source_failed, destino NUNCA é tocado (nada a compensar)", async () => {
    const calls: Action[] = [];
    const applyLeg: ApplyLeg = async (a) => {
      calls.push(a);
      return a.target.id === "A" ? blocked(a, "budget já ajustado hoje") : applied(a);
    };
    const out = await runReallocationSaga(legFrom, legTo, saga, baseCtx, applyLeg);
    expect(out.kind).toBe("source_failed");
    expect(calls.map((a) => a.target.id)).toEqual(["A"]); // parou na origem
  });

  it("destino falha DEPOIS da origem → compensa (devolve a origem ao valor anterior)", async () => {
    const calls: Action[] = [];
    const applyLeg: ApplyLeg = async (a, ctx) => {
      calls.push(a);
      if (a.target.id === "B" && a.id === "B-tc") return failed(a); // destino falha
      // compensação da origem: verifica clamp neutro (referência = valor anterior) e bypass de anti-compounding
      if (a.id.endsWith(":compensate")) {
        expect(a.params[ACTION_PARAM_AMOUNT_MINOR]).toBe(saga.sourceRestoreMinor); // devolve 100
        expect(ctx.budgetAmountByEntity?.get("campaign:A")).toBe(saga.sourceRestoreMinor); // 0% de mudança
        expect(ctx.touchedToday?.has("campaign:A")).toBe(false); // origem fora do budgetChangedToday → não barra
      }
      return applied(a);
    };
    const out = await runReallocationSaga(legFrom, legTo, saga, baseCtx, applyLeg);
    expect(out.kind).toBe("compensated");
    expect(calls.map((a) => a.id)).toEqual(["A-tc", "B-tc", "A-tc:compensate"]);
  });

  it("destino falha E devolução falha → partial (estado parcial explícito)", async () => {
    const applyLeg: ApplyLeg = async (a) => {
      if (a.target.id === "A" && a.id === "A-tc") return applied(a); // origem desceu
      return failed(a); // destino E compensação falham
    };
    const out = await runReallocationSaga(legFrom, legTo, saga, baseCtx, applyLeg);
    expect(out.kind).toBe("partial");
  });

  it("destino no-op (já no alvo) conta como aplicado → done (sem compensar)", async () => {
    const applyLeg: ApplyLeg = async (a) =>
      a.target.id === "B" ? { kind: "noop", action: a } : applied(a);
    const out = await runReallocationSaga(legFrom, legTo, saga, baseCtx, applyLeg);
    expect(out.kind).toBe("done");
  });

  it("destino: a origem entra no touchedToday (cap de entidades/dia coerente)", async () => {
    let ctxForDest: GuardrailContext | undefined;
    const applyLeg: ApplyLeg = async (a, ctx) => {
      if (a.target.id === "B") ctxForDest = ctx;
      return applied(a);
    };
    await runReallocationSaga(legFrom, legTo, saga, baseCtx, applyLeg);
    expect(ctxForDest?.touchedToday?.has("campaign:A")).toBe(true);
  });
});
