import { describe, expect, it } from "vitest";
import type { AutonomyPolicy, GuardrailConfig, NotifyPolicy, Posture } from "@trafego/shared";
import {
  buildConfigChangeEcho,
  CONFIG_CHANGE_LABELS,
  CONFIG_WEAKENS_SAFETY_PREFIX,
  describePlaybookRule,
  mergeConfigText,
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
    ...over,
  };
}

/** Resolve o patch e monta o eco a partir do resultado (o mesmo caminho do gate). */
function echoFor(state: AgentConfigState, patch: AgentConfigPatch, currency?: string): string {
  const r = resolveAgentConfigChange(state, patch);
  return buildConfigChangeEcho({
    current: state,
    next: r.next,
    changed: r.changed,
    weakensSafety: r.weakensSafety,
    ...(currency ? { currency } : {}),
  });
}

describe("buildConfigChangeEcho", () => {
  it("meta: mostra o valor antes → depois (R$) e pede confirmação", () => {
    const echo = echoFor(baseState({ goals: { targetCPA: 50 } }), { goals: { targetCPA: 30 } });
    expect(echo).toContain("meta de CPA");
    expect(echo).toContain("R$ 50,00 → R$ 30,00");
    expect(echo).toContain("Confirma?");
    expect(echo).not.toContain(CONFIG_WEAKENS_SAFETY_PREFIX);
  });

  it("meta: formata a moeda da conta (conta em USD → $, não R$)", () => {
    const echo = echoFor(baseState({ goals: { targetCPA: 50 } }), { goals: { targetCPA: 30 } }, "USD");
    expect(echo).toContain("$ 50,00 → $ 30,00");
    expect(echo).not.toContain("R$");
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

  it("limpar campo de texto: eco mostra antes → limpo", () => {
    const echo = echoFor(baseState({ guidance: "orientação antiga" }), { guidance: "" });
    expect(echo).toContain('orientações ao agente: "orientação antiga" → limpo');
  });

  it("orientações (append): eco mostra o DELTA adicionado (não before→after truncado)", () => {
    const cur = baseState({ guidance: "A" });
    const echo = echoFor(cur, { guidance: "A\nB" }); // append já mesclado pelo chamador
    expect(echo).toContain('orientações ao agente: mantém o texto atual e ADICIONA: "B"');
  });

  it("orientações (append longo): mostra o TRECHO NOVO mesmo com base grande (não some)", () => {
    const base = "x".repeat(500);
    const cur = baseState({ guidance: base });
    const echo = echoFor(cur, { guidance: `${base}\nnova regra importante` }); // append
    expect(echo).toContain("nova regra importante"); // o delta aparece, mesmo com base > 140 chars
  });

  it("orientações (replace): eco mostra antes → depois", () => {
    const cur = baseState({ guidance: "antigo" });
    const echo = echoFor(cur, { guidance: "totalmente novo" }); // replace (não começa com o atual)
    expect(echo).toContain('orientações ao agente: "antigo" → "totalmente novo"');
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

describe("describePlaybookRule", () => {
  it("condição de custo (cpa) + minSpend usam a moeda passada; default = BRL", () => {
    const rule = { scope: "campaign", metric: "cpa", op: ">", value: 40, minSpend: 100, thenType: "pause_entity" };
    expect(describePlaybookRule(rule)).toContain("R$ 40,00");
    expect(describePlaybookRule(rule)).toContain("R$ 100,00");
    const usd = describePlaybookRule(rule, "USD");
    expect(usd).toContain("$ 40,00");
    expect(usd).toContain("$ 100,00");
    expect(usd).not.toContain("R$");
  });

  it("condição não-monetária (roas) ignora a moeda", () => {
    const rule = { scope: "campaign", metric: "roas", op: "<", value: 2, thenType: "pause_entity" };
    expect(describePlaybookRule(rule, "USD")).toContain("2x");
  });
});

describe("mergeConfigText", () => {
  it("append PRESERVA o atual e soma o novo (nunca perde texto)", () => {
    expect(mergeConfigText("não fale de política", "priorize leads", "append")).toBe("não fale de política\npriorize leads");
  });

  it("append com atual vazio = só o novo", () => {
    expect(mergeConfigText(null, "priorize leads", "append")).toBe("priorize leads");
    expect(mergeConfigText("   ", "priorize leads", "append")).toBe("priorize leads");
  });

  it("replace SUBSTITUI (o pedido explícito de trocar)", () => {
    expect(mergeConfigText("velho", "novo", "replace")).toBe("novo");
  });

  it("texto vazio (limpar) passa direto (replace de fato)", () => {
    expect(mergeConfigText("velho", "", "append")).toBe("");
    expect(mergeConfigText("velho", "  ", "replace")).toBe("  ");
  });
});
