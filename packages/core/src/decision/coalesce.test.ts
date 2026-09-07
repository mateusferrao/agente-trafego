import { describe, expect, it } from "vitest";
import type { Action, Ressalva } from "@trafego/shared";
import { ACTION_PARAM_MODE, ACTION_PARAM_PCT, BUDGET_MODE_INCREASE } from "@trafego/shared";
import { coalesceScaleActions } from "./index.js";

const inc = (id: string, pct: number, over?: Partial<Action>): Action => ({
  id,
  type: "adjust_budget",
  target: { level: "campaign", id: "C1" },
  params: { [ACTION_PARAM_MODE]: BUDGET_MODE_INCREASE, [ACTION_PARAM_PCT]: pct },
  source: "llm",
  riskLevel: "medium",
  reason: `escalar ${pct}%`,
  ...over,
});

describe("coalesceScaleActions (unifica escala LLM + determinística na MESMA campanha — bug 52637228752692)", () => {
  it("funde duas altas de budget na mesma entidade → 1 ação, pct mais conservador", () => {
    const out = coalesceScaleActions([inc("llm", 60), inc("det", 20)]);
    expect(out).toHaveLength(1);
    expect(out[0]!.params[ACTION_PARAM_PCT]).toBe(20);
  });

  it("une as ressalvas dos dois lados (dedupe por código)", () => {
    const a: Ressalva = { code: "creative_fatigue", message: "fadiga" };
    const b: Ressalva = { code: "no_significance", message: "sem base" };
    const out = coalesceScaleActions([inc("llm", 60, { ressalvas: [a] }), inc("det", 20, { ressalvas: [b, a] })]);
    expect(out).toHaveLength(1);
    expect((out[0]!.ressalvas ?? []).map((r) => r.code).sort()).toEqual(["creative_fatigue", "no_significance"]);
  });

  it("entidades diferentes → não funde", () => {
    const out = coalesceScaleActions([inc("a", 20), inc("b", 30, { target: { level: "campaign", id: "C2" } })]);
    expect(out).toHaveLength(2);
  });

  it("escala + pausa na mesma entidade → não funde (pausa não é escala)", () => {
    const pause: Action = { id: "p", type: "pause_entity", target: { level: "campaign", id: "C1" }, params: {}, source: "llm", riskLevel: "low", reason: "pausar" };
    const out = coalesceScaleActions([inc("s", 20), pause]);
    expect(out).toHaveLength(2);
  });

  it("resume + increase na mesma entidade → NÃO funde (tipos distintos, não perde o budget)", () => {
    const resume: Action = { id: "r", type: "resume_entity", target: { level: "campaign", id: "C1" }, params: {}, source: "llm", riskLevel: "medium", reason: "reativar" };
    const out = coalesceScaleActions([resume, inc("s", 20)]);
    expect(out).toHaveLength(2);
    expect(out.map((a) => a.type).sort()).toEqual(["adjust_budget", "resume_entity"]);
  });

  it("uma só ação de escala → inalterada", () => {
    const out = coalesceScaleActions([inc("s", 20)]);
    expect(out).toHaveLength(1);
    expect(out[0]!.id).toBe("s");
  });

  it("preserva a ordem e as ações não-escala intactas", () => {
    const pause: Action = { id: "p", type: "pause_entity", target: { level: "campaign", id: "Z" }, params: {}, source: "llm", riskLevel: "low", reason: "pausar" };
    const out = coalesceScaleActions([pause, inc("s", 20)]);
    expect(out.map((a) => a.id)).toEqual(["p", "s"]);
  });
});
