import { describe, expect, it } from "vitest";
import type { AutonomyPolicy, GuardrailConfig, NotifyPolicy } from "@trafego/shared";
import {
  buildConfigChangeEcho,
  CONFIG_CHANGE_LABELS,
  CONFIG_WEAKENS_SAFETY_PREFIX,
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
};

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
    ...over,
  };
}

/** Resolve o patch e monta o eco a partir do resultado (o mesmo caminho do gate). */
function echoFor(state: AgentConfigState, patch: AgentConfigPatch): string {
  const r = resolveAgentConfigChange(state, patch);
  return buildConfigChangeEcho({ current: state, next: r.next, changed: r.changed, weakensSafety: r.weakensSafety });
}

describe("buildConfigChangeEcho", () => {
  it("meta: mostra o valor antes → depois (R$) e pede confirmação", () => {
    const echo = echoFor(baseState({ goals: { targetCPA: 50 } }), { goals: { targetCPA: 30 } });
    expect(echo).toContain("meta de CPA");
    expect(echo).toContain("R$ 50,00 → R$ 30,00");
    expect(echo).toContain("Confirma?");
    expect(echo).not.toContain(CONFIG_WEAKENS_SAFETY_PREFIX);
  });

  it("autonomia subindo → rótulo PT antes→depois + aviso de afrouxamento", () => {
    const echo = echoFor(baseState(), {
      autonomyPolicy: { bySource: { playbook: "act_full", llm: "suggest" } },
    });
    expect(echo).toContain(CONFIG_WEAKENS_SAFETY_PREFIX);
    expect(echo).toContain("sugere e pede OK → age sozinho");
  });

  it("guardrail afrouxando (dry-run off) → aviso de afrouxamento + linha on/off", () => {
    const echo = echoFor(baseState(), { guardrails: { ...GUARDRAILS, dryRun: false } });
    expect(echo).toContain(CONFIG_WEAKENS_SAFETY_PREFIX);
    expect(echo).toContain("modo simulação: ligado → desligado");
  });

  it("cadência: resume o CadenceSpec em PT (antes → depois)", () => {
    const echo = echoFor(baseState({ cadence: null }), { cadence: { kind: "twice_daily", hours: [8, 18] } });
    expect(echo).toContain(CONFIG_CHANGE_LABELS.cadence === "cadência" ? "cadência" : "");
    expect(echo).toContain("padrão do sistema → 2×/dia (8h e 18h)");
  });

  it("campo de texto: mostra o NOVO valor no eco (concreto — §8, não 'atualizado')", () => {
    const echo = echoFor(baseState(), { businessContext: "somos uma clínica de estética em SP" });
    expect(echo).toContain("contexto do negócio:");
    expect(echo).toContain("somos uma clínica de estética em SP");
    expect(echo).not.toContain("atualizado");
  });

  it("campo de texto longo: trunca o valor no eco (não a parede inteira)", () => {
    const long = "x".repeat(500);
    const echo = echoFor(baseState(), { guidance: long });
    expect(echo).toContain("orientações ao agente:");
    expect(echo).toContain("…");
    expect(echo).not.toContain(long);
  });

  it("prompt setado avisa que substitui o do arquétipo + mostra o valor", () => {
    const echo = echoFor(baseState(), { systemPrompt: "analise assim..." });
    expect(echo).toContain("substitui a do arquétipo");
    expect(echo).toContain("analise assim");
  });

  it("limpar campo de texto: eco diz 'limpo/limpas', não despeja valor", () => {
    const echo = echoFor(baseState({ guidance: "orientação antiga" }), { guidance: "" });
    expect(echo).toContain("orientações ao agente: limpas");
  });

  it("proatividade: liga o pulso e mostra a linha em PT, sem afrouxar segurança", () => {
    const echo = echoFor(baseState(), { notifyPolicy: { pulseEnabled: true } });
    expect(echo).toContain("resumo periódico (pulso): desligado → ligado");
    expect(echo).not.toContain(CONFIG_WEAKENS_SAFETY_PREFIX);
  });

  it("proatividade: várias mudanças no mesmo patch viram várias linhas", () => {
    const echo = echoFor(baseState(), {
      notifyPolicy: { alertsEnabled: true, alertsSensitivity: "high", runPushEnabled: false },
    });
    expect(echo).toContain("alerta automático: desligado → ligado");
    expect(echo).toContain("sensibilidade do alerta: normal → alta");
    expect(echo).toContain("aviso após cada análise: ligado → desligado");
  });
});
