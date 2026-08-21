import { describe, expect, it } from "vitest";
import type { AutonomyPolicy, GuardrailConfig } from "@trafego/shared";
import {
  CONFIG_CHANGE_LABELS,
  CUSTOM_CONVERSION_REQUIRED_ERROR,
  resolveAgentConfigChange,
  type AgentConfigPatch,
  type AgentConfigState,
} from "./index.js";

const GUARDRAILS: GuardrailConfig = {
  maxBudgetChangePct: 20,
  maxEntitiesPerDay: 3,
  allowedActions: ["pause_entity"],
  dryRun: true,
  killSwitch: false,
};

const AUTONOMY: AutonomyPolicy = { bySource: { playbook: "suggest", llm: "suggest" } };

/** Estado base neutro — cada teste sobrescreve o que precisa. */
function baseState(over: Partial<AgentConfigState> = {}): AgentConfigState {
  return {
    goals: {},
    businessContext: null,
    guidance: null,
    persona: null,
    tone: null,
    systemPrompt: null,
    cadence: null,
    analysisWindowDays: 7,
    autonomyPolicy: AUTONOMY,
    guardrails: GUARDRAILS,
    modelConfig: {},
    ...over,
  };
}

function resolve(state: AgentConfigState, patch: AgentConfigPatch) {
  return resolveAgentConfigChange(state, patch);
}

describe("resolveAgentConfigChange — merge do model_config", () => {
  it("preserva windowDays e outras chaves ao mesclar knobs avançados", () => {
    const state = baseState({
      analysisWindowDays: 14,
      modelConfig: { windowDays: 14, model: "x", extra: 1 },
    });
    const r = resolve(state, { modelConfig: { topN: 5 } });
    expect(r.next.modelConfig).toEqual({ windowDays: 14, model: "x", extra: 1, topN: 5 });
  });

  it("faz merge campo-a-campo de quality (não substitui o objeto inteiro)", () => {
    const state = baseState({ modelConfig: { quality: { minClicks: 100, minConversions: 20 } } });
    const r = resolve(state, { modelConfig: { quality: { minClicks: 200 } } });
    expect(r.next.modelConfig.quality).toEqual({ minClicks: 200, minConversions: 20 });
  });

  it("grava a janela nova no windowDays do model_config", () => {
    const state = baseState({ analysisWindowDays: 7, modelConfig: { model: "x" } });
    const r = resolve(state, { analysisWindowDays: 30 });
    expect(r.next.modelConfig).toEqual({ model: "x", windowDays: 30 });
    expect(r.next.analysisWindowDays).toBe(30);
  });
});

describe("resolveAgentConfigChange — semântica de texto", () => {
  it('"" limpa o campo (→ null); undefined preserva', () => {
    const state = baseState({ businessContext: "antigo", guidance: "mantém" });
    const r = resolve(state, { businessContext: "  " });
    expect(r.next.businessContext).toBeNull();
    expect(r.next.guidance).toBe("mantém");
  });

  it("apara o texto informado", () => {
    const r = resolve(baseState(), { businessContext: "  Lançamento  " });
    expect(r.next.businessContext).toBe("Lançamento");
  });
});

describe("resolveAgentConfigChange — validação", () => {
  it("custom sem id → error e estado inalterado", () => {
    const state = baseState({ businessContext: "x" });
    const r = resolve(state, { goals: { conversionGoal: "custom" }, businessContext: "novo" });
    expect(r.error).toBe(CUSTOM_CONVERSION_REQUIRED_ERROR);
    expect(r.next).toBe(state);
    expect(r.changed).toEqual([]);
    expect(r.runRelevantChanged).toBe(false);
  });

  it("custom COM id → ok", () => {
    const r = resolve(baseState(), { goals: { conversionGoal: "custom", customConversionId: "123" } });
    expect(r.error).toBeUndefined();
    expect(r.next.goals).toEqual({ conversionGoal: "custom", customConversionId: "123" });
  });
});

describe("resolveAgentConfigChange — runRelevantChanged / cadenceChanged", () => {
  it("meta muda → runRelevant true", () => {
    const r = resolve(baseState(), { goals: { targetCPA: 50 } });
    expect(r.runRelevantChanged).toBe(true);
    expect(r.changed).toContain(CONFIG_CHANGE_LABELS.goals);
  });

  it("janela muda → runRelevant true", () => {
    const r = resolve(baseState({ analysisWindowDays: 7 }), { analysisWindowDays: 14 });
    expect(r.runRelevantChanged).toBe(true);
  });

  it("modelConfig submetido → runRelevant true mesmo sem diff efetivo", () => {
    const r = resolve(baseState(), { modelConfig: {} });
    expect(r.runRelevantChanged).toBe(true);
  });

  it("SÓ cadência muda → runRelevant false, cadenceChanged true", () => {
    const r = resolve(baseState({ cadence: null }), { cadence: { kind: "daily", hour: 8 } });
    expect(r.runRelevantChanged).toBe(false);
    expect(r.cadenceChanged).toBe(true);
    expect(r.changed).toEqual([CONFIG_CHANGE_LABELS.cadence]);
  });

  it("SÓ autonomia muda → runRelevant false (autonomia não afeta a análise)", () => {
    const r = resolve(baseState(), {
      autonomyPolicy: { bySource: { playbook: "act_safe", llm: "suggest" } },
    });
    expect(r.runRelevantChanged).toBe(false);
    expect(r.changed).toEqual([CONFIG_CHANGE_LABELS.autonomyPolicy]);
  });

  it("save idêntico → nada mudou", () => {
    const state = baseState({ goals: { targetCPA: 50 }, businessContext: "x" });
    const r = resolve(state, { goals: { targetCPA: 50 }, businessContext: "x" });
    expect(r.runRelevantChanged).toBe(false);
    expect(r.cadenceChanged).toBe(false);
    expect(r.changed).toEqual([]);
  });
});

describe("resolveAgentConfigChange — weakensSafety", () => {
  it("budget cap ↑ enfraquece", () => {
    const r = resolve(baseState(), { guardrails: { ...GUARDRAILS, maxBudgetChangePct: 40 } });
    expect(r.weakensSafety).toBe(true);
  });

  it("entidades/dia ↑ enfraquece", () => {
    const r = resolve(baseState(), { guardrails: { ...GUARDRAILS, maxEntitiesPerDay: 10 } });
    expect(r.weakensSafety).toBe(true);
  });

  it("ação nova liberada enfraquece", () => {
    const r = resolve(baseState(), {
      guardrails: { ...GUARDRAILS, allowedActions: ["pause_entity", "adjust_budget"] },
    });
    expect(r.weakensSafety).toBe(true);
  });

  it("dry-run desligado enfraquece", () => {
    const r = resolve(baseState(), { guardrails: { ...GUARDRAILS, dryRun: false } });
    expect(r.weakensSafety).toBe(true);
  });

  it("kill-switch desligado enfraquece", () => {
    const state = baseState({ guardrails: { ...GUARDRAILS, killSwitch: true } });
    const r = resolve(state, { guardrails: { ...GUARDRAILS, killSwitch: false } });
    expect(r.weakensSafety).toBe(true);
  });

  it("autonomia subiu no ranking enfraquece", () => {
    const r = resolve(baseState(), {
      autonomyPolicy: { bySource: { playbook: "act_full", llm: "suggest" } },
    });
    expect(r.weakensSafety).toBe(true);
  });

  it("APERTAR a segurança NÃO é weaken (budget ↓, dry-run on, autonomia ↓)", () => {
    const state = baseState({
      guardrails: { ...GUARDRAILS, maxBudgetChangePct: 40, dryRun: false },
      autonomyPolicy: { bySource: { playbook: "act_full", llm: "act_full" } },
    });
    const r = resolve(state, {
      guardrails: { ...GUARDRAILS, maxBudgetChangePct: 10, dryRun: true, killSwitch: true },
      autonomyPolicy: { bySource: { playbook: "suggest", llm: "notify" } },
    });
    expect(r.weakensSafety).toBe(false);
  });
});
