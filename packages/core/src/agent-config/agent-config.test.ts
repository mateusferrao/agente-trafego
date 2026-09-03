import { describe, expect, it } from "vitest";
import type { AutonomyPolicy, GuardrailConfig, NotifyPolicy, Posture } from "@trafego/shared";
import {
  buildConfigChangeEcho,
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

const NOTIFY_POLICY: NotifyPolicy = {
  pulse: { enabled: false, cadence: { kind: "weekly", weekday: 1, hour: 8 } },
  alerts: { enabled: false, sensitivity: "normal", throttleHours: 6 },
  runPush: { enabled: true },
  reactivation: { enabled: false },
};

const POSTURE: Posture = {
  directiveness: "consultative",
  volume: "balanced",
  didacticDepth: "explanatory",
  experienceLevel: null,
};

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
    notifyPolicy: NOTIFY_POLICY,
    posture: POSTURE,
    toolBindings: {},
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

  it("F-worker-1: patch só de quality → columnsChanged marca SÓ modelConfig (autonomy/goals NÃO)", () => {
    const state = baseState({ modelConfig: { quality: { zombieMinSpend: 50 } } });
    const r = resolve(state, { modelConfig: { quality: { zombieMinSpend: 37.5 } } });
    expect(r.columnsChanged.modelConfig).toBe(true);
    // a casca NÃO reescreve autonomy_policy/goals/persona/etc. num patch só de quality (hard-wall real).
    expect(r.columnsChanged.autonomyPolicy).toBe(false);
    expect(r.columnsChanged.goals).toBe(false);
    expect(r.columnsChanged.persona).toBe(false);
    expect(r.columnsChanged.notifyPolicy).toBe(false);
    expect(r.columnsChanged.posture).toBe(false);
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

  it("orientações acima do teto → error (não trunca) guiando a condensar; estado inalterado", () => {
    const state = baseState({ guidance: "ok" });
    const r = resolve(state, { guidance: "x".repeat(9000) });
    expect(r.error).toContain("limite");
    expect(r.error).toContain("resuma"); // guia o agente a condensar
    expect(r.next).toBe(state); // não escreveu o textão
    expect(r.changed).toEqual([]);
  });

  it("texto no limite exato passa (inclusive)", () => {
    const r = resolve(baseState(), { businessContext: "y".repeat(8000) });
    expect(r.error).toBeUndefined();
    expect(r.next.businessContext).toBe("y".repeat(8000));
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

describe("resolveAgentConfigChange — notifyPolicy (F4d)", () => {
  it("sem patch de notifyPolicy → preserva o estado (não muda, não marca changed)", () => {
    const r = resolve(baseState(), { goals: { targetCPA: 50 } });
    expect(r.next.notifyPolicy).toEqual(NOTIFY_POLICY);
    expect(r.changed).not.toContain(CONFIG_CHANGE_LABELS.notifyPolicy);
    expect(r.notifyPolicyChanged).toBe(false);
  });

  it("liga o pulso preservando a cadência e os demais campos (leaf-merge)", () => {
    const r = resolve(baseState(), { notifyPolicy: { pulseEnabled: true } });
    expect(r.next.notifyPolicy).toMatchObject({
      pulse: { enabled: true, cadence: NOTIFY_POLICY.pulse.cadence },
      alerts: NOTIFY_POLICY.alerts,
      runPush: NOTIFY_POLICY.runPush,
      reactivation: NOTIFY_POLICY.reactivation,
      proactiveDrafts: { enabled: NOTIFY_POLICY.proactiveDrafts?.enabled ?? false },
    });
    expect(r.changed).toContain(CONFIG_CHANGE_LABELS.notifyPolicy);
    expect(r.notifyPolicyChanged).toBe(true);
    expect(r.cadenceChanged).toBe(false); // é a cadência do PULSO, não a da análise
  });

  it("muda a cadência do pulso e a sensibilidade do alerta no mesmo patch", () => {
    const r = resolve(baseState(), {
      notifyPolicy: { pulseCadence: { kind: "daily", hour: 9 }, alertsSensitivity: "high" },
    });
    expect(r.next.notifyPolicy.pulse.cadence).toEqual({ kind: "daily", hour: 9 });
    expect(r.next.notifyPolicy.alerts.sensitivity).toBe("high");
    expect(r.next.notifyPolicy.alerts.enabled).toBe(false); // não tocado, preserva
  });

  it("notifyPolicy NÃO conta como runRelevantChanged (não força deep run)", () => {
    const r = resolve(baseState(), { notifyPolicy: { runPushEnabled: false } });
    expect(r.runRelevantChanged).toBe(false);
  });

  it("notifyPolicy NÃO enfraquece a segurança (weakensSafety)", () => {
    const r = resolve(baseState(), { notifyPolicy: { alertsEnabled: true, pulseEnabled: true } });
    expect(r.weakensSafety).toBe(false);
  });

  it("saúde da conta: desliga o aviso (chat) — backfilla o objeto e marca changed", () => {
    const r = resolve(baseState(), { notifyPolicy: { accountHealthEnabled: false } });
    expect(r.next.notifyPolicy.accountHealthAlert?.enabled).toBe(false);
    expect(r.notifyPolicyChanged).toBe(true);
    // não enfraquece segurança nem força deep run (é notificação, não guardrail).
    expect(r.weakensSafety).toBe(false);
    expect(r.runRelevantChanged).toBe(false);
  });

  it("saúde da conta: define teto de gasto customizado → troca a fonte pra custom + valor", () => {
    const r = resolve(baseState(), { notifyPolicy: { accountHealthSpendThresholdMajor: 5000 } });
    expect(r.next.notifyPolicy.accountHealthAlert?.spendThreshold).toEqual({ source: "custom", customValueMajor: 5000 });
  });

  it("saúde da conta: liga o aviso de SALDO baixo + valor (chat) — paridade com o site", () => {
    const r = resolve(baseState(), {
      notifyPolicy: { accountHealthBalanceEnabled: true, accountHealthBalanceThresholdMajor: 100 },
    });
    expect(r.next.notifyPolicy.accountHealthAlert?.balanceThreshold).toEqual({ enabled: true, customValueMajor: 100 });
  });

  it("saúde da conta: substitui o checklist de status (chat) — 'só me avise se for desativada'", () => {
    const r = resolve(baseState(), { notifyPolicy: { accountHealthStatusTriggers: ["disabled"] } });
    expect(r.next.notifyPolicy.accountHealthAlert?.statusTriggers).toEqual(["disabled"]);
  });

  it("saúde da conta: fonte 'meta_cap' volta pro teto da Meta (vence o valor no mesmo patch)", () => {
    const r = resolve(baseState(), {
      notifyPolicy: { accountHealthSpendSource: "meta_cap", accountHealthSpendThresholdMajor: 5000 },
    });
    expect(r.next.notifyPolicy.accountHealthAlert?.spendThreshold).toEqual({ source: "meta_cap" });
  });
});

describe("resolveAgentConfigChange — postura (voz)", () => {
  it("altera um eixo (leaf-merge) e marca 'postura' no changed", () => {
    const r = resolve(baseState(), { posture: { directiveness: "directive" } });
    expect(r.next.posture.directiveness).toBe("directive");
    expect(r.next.posture.volume).toBe("balanced"); // preservado
    expect(r.changed).toContain(CONFIG_CHANGE_LABELS.posture);
  });

  it("postura é VOZ — não força deep run (runRelevantChanged=false)", () => {
    const r = resolve(baseState(), { posture: { volume: "concise" } });
    expect(r.runRelevantChanged).toBe(false);
  });

  it("escolher experienceLevel semeia os 3 eixos", () => {
    const r = resolve(baseState(), { posture: { experienceLevel: "beginner" } });
    expect(r.next.posture).toEqual({
      directiveness: "directive",
      volume: "comprehensive",
      didacticDepth: "explanatory",
      experienceLevel: "beginner",
    });
  });

  it("eixo explícito no mesmo patch sobrepõe a semente do preset", () => {
    const r = resolve(baseState(), { posture: { experienceLevel: "beginner", volume: "concise" } });
    expect(r.next.posture.volume).toBe("concise");
    expect(r.next.posture.directiveness).toBe("directive"); // do preset
    expect(r.next.posture.experienceLevel).toBe("beginner");
  });

  it("postura NÃO enfraquece a segurança", () => {
    const r = resolve(baseState(), { posture: { directiveness: "directive", volume: "comprehensive" } });
    expect(r.weakensSafety).toBe(false);
  });

  it("patch sem mudança real não marca postura", () => {
    const r = resolve(baseState(), { posture: { directiveness: "consultative" } });
    expect(r.changed).not.toContain(CONFIG_CHANGE_LABELS.posture);
  });

  it("eco concreto: antes → depois por eixo (PT amigável)", () => {
    const r = resolve(baseState(), { posture: { directiveness: "directive" } });
    const echo = buildConfigChangeEcho({
      current: baseState(),
      next: r.next,
      changed: r.changed,
      weakensSafety: r.weakensSafety,
    });
    expect(echo.toLowerCase()).toContain("diretividade");
    expect(echo).toContain("Consultivo");
    expect(echo).toContain("Diretivo");
  });
});

describe("toolBindings (A3 — on/off por-ação, gap de auto-config por chat)", () => {
  it("leaf-merge: só a chave ENVIADA muda, o resto preserva", () => {
    const r = resolve(baseState({ toolBindings: { create_campaign: true, adjust_budget: true } }), {
      toolBindings: { create_campaign: false },
    });
    expect(r.next.toolBindings).toEqual({ create_campaign: false, adjust_budget: true });
    expect(r.toolBindingsChanged).toBe(true);
    expect(r.changed).toContain(CONFIG_CHANGE_LABELS.toolBindings);
  });

  it("patch ausente → não mexe (toolBindingsChanged=false)", () => {
    const r = resolve(baseState({ toolBindings: { create_campaign: true } }), {});
    expect(r.next.toolBindings).toEqual({ create_campaign: true });
    expect(r.toolBindingsChanged).toBe(false);
    expect(r.changed).not.toContain(CONFIG_CHANGE_LABELS.toolBindings);
  });

  it("patch com o MESMO valor já vigente → sem mudança real", () => {
    const r = resolve(baseState({ toolBindings: { pause_entity: true } }), { toolBindings: { pause_entity: true } });
    expect(r.toolBindingsChanged).toBe(false);
  });

  it("liga uma capacidade nova (chave ausente antes) e mantém as demais", () => {
    const r = resolve(baseState({ toolBindings: { pause_entity: true } }), { toolBindings: { duplicate_scale: true } });
    expect(r.next.toolBindings).toEqual({ pause_entity: true, duplicate_scale: true });
  });
});
