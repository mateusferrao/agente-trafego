import { describe, expect, it, vi } from "vitest";
import { agents } from "@trafego/db";
import { APPROVAL_APPLY_QUEUE } from "@trafego/shared";
import type { AgentConfigState } from "@trafego/core";
import type { GuardrailConfig, AutonomyPolicy, NotifyPolicy, Action } from "@trafego/shared";
import {
  AGENT_TOOL_NAMES,
  CONCIERGE_TOOL_NAMES,
  CONFIG_CHAT_TOOL_NAMES,
  CONFIRM_LEARNING_TOOL_NAME,
  GROUP_CONCIERGE_TOOL_NAMES,
  actionFromToolCall,
  resolveBudgetMinor,
  buildCapabilitiesText,
  configPatchFromToolCall,
  diceSimilarity,
  makeConversationTools,
  mergeConfigUpdatePatches,
  normalizeAccountText,
  playbookOpFromToolCall,
  resolveFocusMatch,
  ruleRowToDescriptor,
  type ConversationToolContext,
} from "./tools.js";

const CTX: ConversationToolContext = {
  orgId: "org-1",
  agentId: "ag-1",
  adAccountId: "acc-1",
  timezone: "America/Sao_Paulo",
  ref: { kind: "contact", contactId: "ct-1" },
  conversationId: "cv-1",
};

function pending(id: string, orgId = "org-1") {
  return { id, orgId, status: "pending", action: { target: { name: "Campanha X" } } };
}

function makeDeps(getByIdImpl: (id: string) => unknown) {
  const enqueue = vi.fn(async (_spec: { queue: string; name: string; payload: unknown }) => {});
  const resolve = vi.fn(async (_id: string, _input: { status: string }) => ({}) as never);
  const getById = vi.fn(async (id: string) => getByIdImpl(id) as never);
  const deps = {
    db: {} as never,
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
    ports: {
      approval: { getById, resolve, listPendingByOrg: vi.fn(async () => []) },
      scheduler: { enqueue },
      metering: {},
    },
    costCapUsd: 0,
  } as never;
  return { deps, enqueue, resolve, getById };
}

function toolOf(deps: never, name: string): { invoke: (args: unknown) => Promise<string> } {
  const found = makeConversationTools(deps, CTX, AGENT_TOOL_NAMES).find((t) => t.name === name)!;
  return found as unknown as { invoke: (args: unknown) => Promise<string> };
}

describe("always-bind de leitura em grupo multi-conta (S6)", () => {
  it("GROUP_CONCIERGE binda reads + set_focus + trigger_analysis (read-like); sem escrita/config/revert", () => {
    expect(GROUP_CONCIERGE_TOOL_NAMES.has("get_fresh_metrics")).toBe(true);
    expect(GROUP_CONCIERGE_TOOL_NAMES.has("get_campaign_analysis")).toBe(true);
    expect(GROUP_CONCIERGE_TOOL_NAMES.has("set_focus")).toBe(true);
    expect(GROUP_CONCIERGE_TOOL_NAMES.has("list_pending")).toBe(true);
    // rodar análise é READ-LIKE (nenhuma escrita na Meta) → binda no concierge; resolve o agente do
    // focused_account_id persistente, ignorando o TTL do foco (que existe só p/ ESCRITA re-confirmar).
    expect(GROUP_CONCIERGE_TOOL_NAMES.has("trigger_analysis")).toBe(true);
    expect(GROUP_CONCIERGE_TOOL_NAMES.has("pause_entity")).toBe(false);
    expect(GROUP_CONCIERGE_TOOL_NAMES.has("set_goal")).toBe(false);
    expect(GROUP_CONCIERGE_TOOL_NAMES.has("revert_action")).toBe(false);
  });

  it("read tool sem foco (adAccountId vazio) → pede a conta (self-guard), sem tocar o db", async () => {
    const { deps } = makeDeps(() => null);
    const ctxNoFocus: ConversationToolContext = {
      ...CTX,
      agentId: "",
      adAccountId: "",
      ref: { kind: "group", groupId: "grp-1", participantPhone: "+5511999999999" },
      multiAccount: true,
    };
    const getMetrics = makeConversationTools(deps, ctxNoFocus, GROUP_CONCIERGE_TOOL_NAMES).find((t) => t.name === "get_metrics")! as unknown as {
      invoke: (a: unknown) => Promise<string>;
    };
    const out = await getMetrics.invoke({ periodDays: 7 });
    expect(out.toLowerCase()).toContain("conta");
    expect(out.toLowerCase()).toContain("foca");
  });

  it("trigger_analysis no concierge SEM foco persistente → pede a conta, sem disparar run", async () => {
    // db devolve [] pra conversations → sem focused_account_id → early-return honesto (nada de dispatch).
    const enqueue = vi.fn(async () => {});
    const db = {
      select: () => db,
      from: () => db,
      innerJoin: () => db,
      where: () => db,
      limit: async () => [] as never[],
    };
    const deps = {
      db: db as never,
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
      ports: { approval: { getById: vi.fn(), resolve: vi.fn(), listPendingByOrg: vi.fn(async () => []) }, scheduler: { enqueue }, metering: {} },
      costCapUsd: 0,
    } as never;
    const ctxConcierge: ConversationToolContext = {
      ...CTX,
      agentId: "",
      adAccountId: "",
      ref: { kind: "group", groupId: "grp-1", participantPhone: "+5511999999999" },
      multiAccount: true,
    };
    const trigger = makeConversationTools(deps, ctxConcierge, GROUP_CONCIERGE_TOOL_NAMES).find((t) => t.name === "trigger_analysis")! as unknown as {
      invoke: (a: unknown) => Promise<string>;
    };
    const out = await trigger.invoke({});
    expect(out.toLowerCase()).toContain("conta");
    expect(enqueue).not.toHaveBeenCalled();
  });
});

describe("set_focus tool (footgun S3: aplica o foco no MESMO turno)", () => {
  const ACC = { id: "acc-B", name: "Clínica B", adAccountId: "act_222" };
  /** db falso: from(agents) → `agentRows`; from(*) → a conta; update → no-op (espionável). */
  function focusDb(agentRows: unknown[], updateSpy = vi.fn()) {
    let target: unknown[] = [];
    const chain: Record<string, unknown> = {
      select: () => chain,
      from: (t: unknown) => {
        target = t === agents ? agentRows : [ACC];
        return chain;
      },
      innerJoin: () => chain,
      where: () => chain,
      orderBy: () => chain,
      limit: () => chain,
      then: (resolve: (v: unknown[]) => unknown) => resolve(target),
      update: () => ({ set: (v: unknown) => { updateSpy(v); return { where: async () => {} }; } }),
    };
    return chain as never;
  }
  const groupCtx = (): ConversationToolContext => ({
    orgId: "org-1",
    agentId: "ag-A",
    adAccountId: "acc-A",
    timezone: "America/Sao_Paulo",
    ref: { kind: "group", groupId: "grp-1", participantPhone: "+5511999999999" },
    conversationId: "cv-1",
    multiAccount: true,
  });
  const setFocusTool = (deps: never, ctx: ConversationToolContext) =>
    makeConversationTools(deps, ctx, AGENT_TOOL_NAMES).find((t) => t.name === "set_focus")! as unknown as {
      invoke: (a: unknown) => Promise<string>;
    };

  it("conta COM agente ativo: muta ctx.adAccountId/agentId/accountName (turno-local)", async () => {
    const { deps } = makeDeps(() => null);
    (deps as { db: unknown }).db = focusDb([{ agentId: "ag-B" }]);
    const ctx = groupCtx();
    const out = await setFocusTool(deps, ctx).invoke({ name: "Clínica B" });

    expect(out).toContain("foquei na conta Clínica B");
    expect(ctx.adAccountId).toBe("acc-B");
    expect(ctx.agentId).toBe("ag-B");
    expect(ctx.accountName).toBe("Clínica B");
  });

  it("conta SEM agente ativo: não promete nem persiste foco, e não muta o ctx", async () => {
    const { deps } = makeDeps(() => null);
    const updateSpy = vi.fn();
    (deps as { db: unknown }).db = focusDb([], updateSpy);
    const ctx = groupCtx();
    const out = await setFocusTool(deps, ctx).invoke({ name: "Clínica B" });

    expect(out).toContain("não tem um agente ativo");
    expect(updateSpy).not.toHaveBeenCalled(); // não persistiu focusedAccountId
    expect(ctx.adAccountId).toBe("acc-A"); // ctx intacto
    expect(ctx.agentId).toBe("ag-A");
  });
});

describe("describe_capabilities tool", () => {
  const capTool = (deps: never, ctx: ConversationToolContext, allow: Set<string>) =>
    makeConversationTools(deps, ctx, allow).find((t) => t.name === "describe_capabilities")! as unknown as {
      invoke: (a: unknown) => Promise<string>;
    };
  const dbWithAutonomy = (playbook: string, llm: string) =>
    ({
      select: () => ({ from: () => ({ where: () => ({ limit: async () => [{ autonomyPolicy: { bySource: { playbook, llm } } }] }) }) }),
    }) as never;

  it("concierge (sem agente em contexto) → visão geral, sem tocar o db", async () => {
    const { deps } = makeDeps(() => null);
    const out = await capTool(deps, { ...CTX, agentId: "" }, new Set(["describe_capabilities"])).invoke({});
    expect(out.toLowerCase()).toContain("foca");
    expect(out.toLowerCase()).toContain("panorama");
    // paridade com o fix de concierge: config é por-foco, não "pelo site" — a capacidade cita configurar.
    expect(out.toLowerCase()).toContain("configurar");
  });

  it("em GRUPO declara que acompanha a conversa recente (S5, honestidade contextual)", async () => {
    const { deps } = makeDeps(() => null);
    const groupCtx: ConversationToolContext = { ...CTX, agentId: "", ref: { kind: "group", groupId: "grp-1", participantPhone: "+5511999999999" } };
    const out = await capTool(deps, groupCtx, new Set(["describe_capabilities"])).invoke({});
    expect(out.toLowerCase()).toContain("grupo");
    expect(out.toLowerCase()).toContain("só respondo quando me chamam");
  });

  it("reflete o contexto: escrita só quando habilitada + config conforme o kill-switch", async () => {
    const { deps } = makeDeps(() => null);
    (deps as { db: unknown }).db = dbWithAutonomy("suggest", "notify");

    const on = await capTool(deps, { ...CTX, configViaChat: true }, new Set(["describe_capabilities", "pause_entity"])).invoke({});
    expect(on).toContain("pausar");
    expect(on).toContain("Mudo minha configuração"); // config-por-chat ligada

    const off = await capTool(deps, { ...CTX, configViaChat: false }, new Set(["describe_capabilities"])).invoke({});
    expect(off).toContain("desligado nos guardrails"); // sem write tool habilitada
    expect(off).toContain("pelo site"); // config off
  });
});

describe("approve tool", () => {
  it("enfileira o apply-service p/ cada pendente da org, com o contato p/ o desfecho", async () => {
    const { deps, enqueue } = makeDeps((id) => (id === "ap-1" ? pending("ap-1") : null));
    const out = (await toolOf(deps, "approve").invoke({ approvalIds: ["ap-1", "ap-x"] })) as string;

    expect(enqueue).toHaveBeenCalledOnce();
    const spec = enqueue.mock.calls[0]![0] as { queue: string; payload: unknown };
    expect(spec.queue).toBe(APPROVAL_APPLY_QUEUE);
    expect(spec.payload).toEqual({ orgId: "org-1", approvalId: "ap-1", notifyRef: { kind: "contact", contactId: "ct-1" } });
    expect(out).toContain("aplicando");
  });

  it("pendente de OUTRA org → ignora (não enfileira)", async () => {
    const { deps, enqueue } = makeDeps(() => pending("ap-1", "org-outra"));
    await toolOf(deps, "approve").invoke({ approvalIds: ["ap-1"] });
    expect(enqueue).not.toHaveBeenCalled();
  });
});

describe("actionFromToolCall", () => {
  const args = (o: Record<string, unknown>) => ({ entityLevel: "campaign", entityId: "C1", entityName: "Boa", ...o });

  it("pause → Action neutra com target correto", () => {
    const a = actionFromToolCall("pause_entity", args({}), "tc1");
    expect(a?.type).toBe("pause_entity");
    expect(a?.target).toEqual({ level: "campaign", id: "C1", name: "Boa" });
    expect(a?.id).toBe("tc1");
  });

  it("adjust_budget set → guarda amountMajor (conversão adiada até saber a moeda)", () => {
    const a = actionFromToolCall("adjust_budget", args({ mode: "set", amountReais: 200 }), "tc2");
    // NÃO converte aqui (a moeda ainda não é conhecida) — guarda o valor maior; a conversão
    // p/ unidade menor acontece em resolveBudgetMinor quando a conta é resolvida.
    expect(a?.params).toEqual({ mode: "set", amountMajor: 200 });
  });

  it("adjust_budget increase → pct (magnitude)", () => {
    const a = actionFromToolCall("adjust_budget", args({ mode: "increase", pct: 30 }), "tc3");
    expect(a?.params).toEqual({ mode: "increase", pct: 30 });
  });

  it("set_status → status nos params", () => {
    const a = actionFromToolCall("set_status", args({ status: "paused" }), "tc4");
    expect(a?.params).toEqual({ status: "paused" });
  });

  it("tool desconhecida → null", () => {
    expect(actionFromToolCall("get_metrics", args({}), "x")).toBeNull();
  });

  it("edit_audience → null (só o ramo dedicado edit_audience trata; não é ação genérica)", () => {
    // A1: edit_audience NÃO está em WRITE_TOOL_NAMES — o roteamento vai pro ramo
    // dedicado (confirmWriteGate/routeConversation), nunca por actionFromToolCall.
    expect(actionFromToolCall("edit_audience", args({ adsetId: "AS1" }), "x")).toBeNull();
  });

  it("set sem amountReais → null (não vira ação inválida)", () => {
    expect(actionFromToolCall("adjust_budget", args({ mode: "set" }), "x")).toBeNull();
  });
});

describe("resolveBudgetMinor (conversão maior→menor pela moeda)", () => {
  const setAction = (): Action =>
    actionFromToolCall("adjust_budget", { entityLevel: "campaign", entityId: "C1", mode: "set", amountReais: 200 }, "tc")!;

  it("BRL: amountMajor 200 → amountMinor 20000 (×100); amountMajor some", () => {
    const r = resolveBudgetMinor(setAction(), "BRL");
    expect(r.params).toEqual({ mode: "set", amountMinor: 20000 });
  });
  it("JPY: amountMajor 200 → amountMinor 200 (×1, não infla 100×)", () => {
    const r = resolveBudgetMinor(setAction(), "JPY");
    expect(r.params).toEqual({ mode: "set", amountMinor: 200 });
  });
  it("BHD: amountMajor 200 → amountMinor 200000 (×1000)", () => {
    const r = resolveBudgetMinor(setAction(), "BHD");
    expect(r.params).toEqual({ mode: "set", amountMinor: 200000 });
  });
  it("no-op p/ ação sem amountMajor (pause/status/pct)", () => {
    const pause = actionFromToolCall("pause_entity", { entityLevel: "campaign", entityId: "C1" }, "tc")!;
    expect(resolveBudgetMinor(pause, "JPY")).toEqual(pause);
    const inc = actionFromToolCall("adjust_budget", { entityLevel: "campaign", entityId: "C1", mode: "increase", pct: 30 }, "tc")!;
    expect(resolveBudgetMinor(inc, "JPY").params).toEqual({ mode: "increase", pct: 30 });
  });
});

// ─── Config por chat (S2.3–S2.6) ─────────────────────────────────────────
const GUARDRAILS: GuardrailConfig = {
  maxBudgetChangePct: 20,
  maxEntitiesPerDay: 3,
  allowedActions: ["pause_entity"],
  dryRun: true,
  killSwitch: false,
};
const AUTONOMY: AutonomyPolicy = { bySource: { playbook: "suggest", llm: "suggest" }, autoConfigViaChat: true };
const NOTIFY_POLICY: NotifyPolicy = {
  pulse: { enabled: false, cadence: { kind: "weekly", weekday: 1, hour: 8 } },
  alerts: { enabled: false, sensitivity: "normal", throttleHours: 6 },
  runPush: { enabled: true },
  reactivation: { enabled: false },
};

function state(over: Partial<AgentConfigState> = {}): AgentConfigState {
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
    posture: { directiveness: "consultative", volume: "balanced", didacticDepth: "explanatory", experienceLevel: null },
    toolBindings: {},
    ...over,
  };
}

describe("configPatchFromToolCall — postura", () => {
  it("set_directiveness/set_volume/set_didactic_depth viram PosturePatch do eixo", () => {
    expect(configPatchFromToolCall("set_directiveness", { level: "directive" }, state())?.posture).toEqual({ directiveness: "directive" });
    expect(configPatchFromToolCall("set_volume", { level: "concise" }, state())?.posture).toEqual({ volume: "concise" });
    expect(configPatchFromToolCall("set_didactic_depth", { level: "direct" }, state())?.posture).toEqual({ didacticDepth: "direct" });
  });
  it("set_experience_level vira PosturePatch com o preset (semeia no resolver)", () => {
    expect(configPatchFromToolCall("set_experience_level", { level: "advanced" }, state())?.posture).toEqual({ experienceLevel: "advanced" });
  });
});

describe("configPatchFromToolCall", () => {
  it("set_goal: só troca o campo enviado; preserva o resto da meta", () => {
    const cur = state({ goals: { targetCPA: 50, targetROAS: 3 } });
    const patch = configPatchFromToolCall("set_goal", { targetCPA: 30 }, cur);
    expect(patch?.goals).toEqual({ targetCPA: 30, targetROAS: 3 });
  });

  it("set_goal: null limpa o campo (vira undefined na meta)", () => {
    const cur = state({ goals: { targetCPA: 50 } });
    const patch = configPatchFromToolCall("set_goal", { targetCPA: null }, cur);
    expect(patch?.goals?.targetCPA).toBeUndefined();
  });

  it("set_autonomy: só troca a origem enviada e preserva autoConfigViaChat", () => {
    const patch = configPatchFromToolCall("set_autonomy", { playbook: "act_safe" }, state());
    expect(patch?.autonomyPolicy).toEqual({
      bySource: { playbook: "act_safe", llm: "suggest" },
      autoConfigViaChat: true,
    });
  });

  it("set_autonomy: byAction liga act_full pra create_campaign (gap #2 — antes só existia via site)", () => {
    const patch = configPatchFromToolCall(
      "set_autonomy",
      { byAction: [{ toolKey: "create_campaign", level: "act_full" }] },
      state(),
    );
    expect(patch?.autonomyPolicy?.byAction).toEqual({ create_campaign: "act_full" });
    expect(patch?.autonomyPolicy?.bySource).toEqual({ playbook: "suggest", llm: "suggest" }); // preservado
  });

  it("set_autonomy: byAction level=null remove a chave (volta a herdar a origem)", () => {
    const cur = state({ autonomyPolicy: { ...AUTONOMY, byAction: { create_campaign: "act_full", adjust_budget: "act_safe" } } });
    const patch = configPatchFromToolCall("set_autonomy", { byAction: [{ toolKey: "create_campaign", level: null }] }, cur);
    expect(patch?.autonomyPolicy?.byAction).toEqual({ adjust_budget: "act_safe" });
  });

  it("set_autonomy: byAction zerando a ÚLTIMA chave limpa byAction (undefined, não objeto vazio)", () => {
    const cur = state({ autonomyPolicy: { ...AUTONOMY, byAction: { create_campaign: "act_full" } } });
    const patch = configPatchFromToolCall("set_autonomy", { byAction: [{ toolKey: "create_campaign", level: null }] }, cur);
    expect(patch?.autonomyPolicy?.byAction).toBeUndefined();
  });

  it("set_autonomy: byAction ausente NÃO mexe no byAction atual", () => {
    const cur = state({ autonomyPolicy: { ...AUTONOMY, byAction: { create_campaign: "act_full" } } });
    const patch = configPatchFromToolCall("set_autonomy", { playbook: "act_safe" }, cur);
    expect(patch?.autonomyPolicy?.byAction).toEqual({ create_campaign: "act_full" });
  });

  it("set_autonomy: scaleAggressivePreference (gap #4 — antes só existia via site)", () => {
    const patch = configPatchFromToolCall("set_autonomy", { scaleAggressivePreference: "duplicate" }, state());
    expect(patch?.autonomyPolicy?.scaleAggressivePreference).toBe("duplicate");
  });

  it("set_action_access: liga/desliga ações específicas (gap #3 — mesma fonte da tela 'Ações permitidas')", () => {
    const patch = configPatchFromToolCall(
      "set_action_access",
      { actions: [{ toolKey: "create_campaign", enabled: false }, { toolKey: "adjust_budget", enabled: true }] },
      state(),
    );
    expect(patch?.toolBindings).toEqual({ create_campaign: false, adjust_budget: true });
  });

  it("set_guardrail: dryRun=false é aplicado (não confundido com 'manter')", () => {
    const patch = configPatchFromToolCall("set_guardrail", { dryRun: false }, state());
    expect(patch?.guardrails?.dryRun).toBe(false);
    expect(patch?.guardrails?.maxBudgetChangePct).toBe(20); // preservado
  });

  it("set_cadence: twice_daily → kind + hours (tupla)", () => {
    const patch = configPatchFromToolCall("set_cadence", { kind: "twice_daily", hour: 8, secondHour: 18 }, state());
    expect(patch?.cadence).toEqual({ kind: "twice_daily", hours: [8, 18] });
  });

  it("set_cadence: raw sem cron → não muda a cadência (patch vazio)", () => {
    const patch = configPatchFromToolCall("set_cadence", { kind: "raw" }, state());
    expect(patch).toEqual({});
  });

  it("set_notifications: liga o pulso sem cadência → só pulseEnabled no patch", () => {
    const patch = configPatchFromToolCall("set_notifications", { pulseEnabled: true }, state());
    expect(patch).toEqual({ notifyPolicy: { pulseEnabled: true } });
  });

  it("set_notifications: cadência do pulso reusa o formato de set_cadence", () => {
    const patch = configPatchFromToolCall(
      "set_notifications",
      { pulseCadence: { kind: "daily", hour: 9 } },
      state(),
    );
    expect(patch).toEqual({ notifyPolicy: { pulseCadence: { kind: "daily", hour: 9 } } });
  });

  it("set_notifications: liga alerta + sensibilidade no mesmo call", () => {
    const patch = configPatchFromToolCall(
      "set_notifications",
      { alertsEnabled: true, alertsSensitivity: "high", alertsThrottleHours: 3 },
      state(),
    );
    expect(patch).toEqual({
      notifyPolicy: { alertsEnabled: true, alertsSensitivity: "high", alertsThrottleHours: 3 },
    });
  });

  it("set_notifications: desliga o push do cron", () => {
    const patch = configPatchFromToolCall("set_notifications", { runPushEnabled: false }, state());
    expect(patch).toEqual({ notifyPolicy: { runPushEnabled: false } });
  });

  it("set_notifications: sem nenhum campo enviado → patch de notifyPolicy vazio", () => {
    const patch = configPatchFromToolCall("set_notifications", {}, state());
    expect(patch).toEqual({ notifyPolicy: {} });
  });

  it("set_notifications: 'muda o saldo base pra 100' → limiar de SALDO, NUNCA o teto (bug)", () => {
    const patch = configPatchFromToolCall(
      "set_notifications",
      { accountHealthBalanceEnabled: true, accountHealthBalanceThreshold: 100 },
      state(),
    );
    expect(patch).toEqual({
      notifyPolicy: { accountHealthBalanceEnabled: true, accountHealthBalanceThresholdMajor: 100 },
    });
  });

  it("set_notifications: checklist de status + fonte do teto viram patch (paridade com o site)", () => {
    const patch = configPatchFromToolCall(
      "set_notifications",
      { accountHealthStatusTriggers: ["disabled", "closed"], accountHealthSpendSource: "meta_cap" },
      state(),
    );
    expect(patch).toEqual({
      notifyPolicy: { accountHealthStatusTriggers: ["disabled", "closed"], accountHealthSpendSource: "meta_cap" },
    });
  });

  it("set_persona: texto vira patch; identidade não é goal/guardrail", () => {
    const patch = configPatchFromToolCall("set_persona", { text: "vendedor consultivo" }, state());
    expect(patch).toEqual({ persona: "vendedor consultivo" });
  });

  it("set_guidance append: PRESERVA a orientação atual e soma (não sobrescreve)", () => {
    const cur = state({ guidance: "não fale de política" });
    const patch = configPatchFromToolCall("set_guidance", { text: "priorize leads", mode: "append" }, cur);
    expect(patch).toEqual({ guidance: "não fale de política\npriorize leads" });
  });

  it("set_guidance replace: SUBSTITUI a orientação atual", () => {
    const cur = state({ guidance: "orientação antiga" });
    const patch = configPatchFromToolCall("set_guidance", { text: "só o novo", mode: "replace" }, cur);
    expect(patch).toEqual({ guidance: "só o novo" });
  });

  it("set_business_context append: soma ao contexto atual", () => {
    const cur = state({ businessContext: "clínica de estética" });
    const patch = configPatchFromToolCall("set_business_context", { text: "ticket médio R$2000", mode: "append" }, cur);
    expect(patch).toEqual({ businessContext: "clínica de estética\nticket médio R$2000" });
  });

  it("tool que não é update de config → null", () => {
    expect(configPatchFromToolCall("reseed_archetype", { archetype: "otimizador" }, state())).toBeNull();
  });
});

describe("normalizeAccountText", () => {
  it("acento, caixa, espaço duplo e zero à esquerda", () => {
    expect(normalizeAccountText("Clínica  BH   02")).toBe("clinica bh 2");
  });

  it("sem acento, só caixa e zero à esquerda", () => {
    expect(normalizeAccountText("CLINICA BH 02")).toBe("clinica bh 2");
  });
});

describe("diceSimilarity", () => {
  it("strings idênticas → 1", () => {
    expect(diceSimilarity("clinica bh", "clinica bh")).toBe(1);
  });

  it("overlap parcial conhecido → entre 0 e 1", () => {
    const score = diceSimilarity("clinica bh", "clinica bh 2");
    expect(score).toBeGreaterThan(0.5);
    expect(score).toBeLessThan(1);
  });

  it("strings totalmente diferentes → score baixo", () => {
    expect(diceSimilarity("clinica bh", "loja de roupas xyz")).toBeLessThan(0.2);
  });
});

describe("resolveFocusMatch", () => {
  const bh = { id: "u-bh", name: "CLÍNICA BH", adAccountId: "187285994671922" };
  const bh02 = { id: "u-02", name: "CLINICA BH 02", adAccountId: "634449609533551" };
  const unrelated = { id: "u-x", name: "Loja de Roupas XYZ", adAccountId: "999" };
  const pilates = { id: "u-p", name: "Studio Pilates Ipanema", adAccountId: "1" };
  const yoga = { id: "u-y", name: "Studio Yoga Barra", adAccountId: "2" };

  it("nenhuma linha → none", () => {
    expect(resolveFocusMatch([], "x").kind).toBe("none");
  });

  it("uma linha → one", () => {
    const m = resolveFocusMatch([bh02], "clinica");
    expect(m).toEqual({ kind: "one", row: bh02 });
  });

  it("várias, mas o id externo bate exatamente → desempata p/ essa", () => {
    const m = resolveFocusMatch([bh, bh02], "187285994671922");
    expect(m).toEqual({ kind: "one", row: bh });
  });

  it("várias, mas o nome bate EXATO → desempata (não o substring)", () => {
    const m = resolveFocusMatch([bh, bh02], "clínica bh");
    expect(m).toEqual({ kind: "one", row: bh });
  });

  it("bug do print: acento + zero à esquerda → acha direto (nome exato normalizado)", () => {
    const m = resolveFocusMatch([bh, bh02], "Clínica bh 2");
    expect(m).toEqual({ kind: "one", row: bh02 });
  });

  it("typo (letra faltando) → acha por similaridade", () => {
    const m = resolveFocusMatch([bh, unrelated], "Clinca BH");
    expect(m).toEqual({ kind: "one", row: bh });
  });

  it("ordem de palavra trocada → acha por similaridade", () => {
    const m = resolveFocusMatch([bh, unrelated], "BH Clínica");
    expect(m).toEqual({ kind: "one", row: bh });
  });

  it("nome não relacionado não casa → none", () => {
    const m = resolveFocusMatch([unrelated], "clinica bh");
    expect(m.kind).toBe("none");
  });

  it("auto-pick por margem clara entre 2 contas parecidas", () => {
    const m = resolveFocusMatch([pilates, yoga], "studio pilates rj");
    expect(m).toEqual({ kind: "one", row: pilates });
  });

  it("ambíguo genuíno, ranqueado, sem overflow", () => {
    const m = resolveFocusMatch([bh, bh02], "clinica");
    expect(m).toEqual({ kind: "ambiguous", rows: [bh, bh02], omittedCount: 0 });
  });

  it("lista de ambíguos capada com overflow", () => {
    const many = Array.from({ length: 6 }, (_, i) => ({
      id: `u-${i}`,
      name: `Clinica Unidade 0${i + 1}`,
      adAccountId: `id-${i}`,
    }));
    const m = resolveFocusMatch(many, "clinica unidade");
    expect(m.kind).toBe("ambiguous");
    if (m.kind === "ambiguous") {
      expect(m.rows.length).toBe(5);
      expect(m.omittedCount).toBe(1);
    }
  });

  it("único candidato plausível mas pouco confiante → pergunta, não foca sozinho", () => {
    const weak = { id: "u-w", name: "abyyyyyy", adAccountId: "w1" };
    const m = resolveFocusMatch([weak], "abxxxxxx");
    expect(m).toEqual({ kind: "ambiguous", rows: [weak], omittedCount: 0 });
  });

  it("query só espaço + conta sem nome (null) → none (não casa nome vazio com query vazia)", () => {
    const semNome = { id: "u-null", name: null, adAccountId: "999" };
    const m = resolveFocusMatch([semNome], "   ");
    expect(m).toEqual({ kind: "none" });
  });

  it("fragmento curto contido num nome de conta longo → acha (restaura garantia do ILIKE antigo)", () => {
    const longa = { id: "u-long", name: "Studio Pilates e Yoga Zona Sul Unidade Copacabana", adAccountId: "777" };
    const m = resolveFocusMatch([longa, unrelated], "copacabana");
    expect(m).toEqual({ kind: "one", row: longa });
  });
});

describe("list_accounts (allowlist wiring)", () => {
  it("presente tanto em modo concierge quanto com agente focado", () => {
    const { deps } = makeDeps(() => null);
    const conciergeNames = makeConversationTools(deps, { ...CTX, agentId: "" }, CONCIERGE_TOOL_NAMES).map((t) => t.name);
    const focusedNames = makeConversationTools(deps, CTX, AGENT_TOOL_NAMES).map((t) => t.name);
    expect(conciergeNames).toContain("list_accounts");
    expect(focusedNames).toContain("list_accounts");
  });
});

describe("descriptions de escrita/criação — S0a: procedimento-por-tool migrou do system prompt", () => {
  const WRITE_CREATE_TOOL_NAMES = new Set(["adjust_budget", "scale_winner", "create_campaign", "copy_campaign", "adjust_draft", "regenerate_copy"]);
  function descriptionOf(name: string): string {
    const { deps } = makeDeps(() => null);
    const found = makeConversationTools(deps, CTX, WRITE_CREATE_TOOL_NAMES).find((t) => t.name === name)!;
    return (found as unknown as { description: string }).description;
  }

  it("adjust_budget: orienta perguntar campanha/valor quando a intenção de orçamento vier incompleta", () => {
    expect(descriptionOf("adjust_budget")).toContain("NÃO chame ainda — pergunte concretamente o que falta");
  });

  it("create_campaign: pedido de recomendação é o mesmo gatilho, e não confundir com recomendação genérica", () => {
    const d = descriptionOf("create_campaign");
    expect(d).toContain("Pedido de RECOMENDAÇÃO de campanha nova");
    expect(d).toContain("recomendação GENÉRICA da conta");
  });

  it("copy_campaign: sugere excluir quem já converteu ao trocar público pra remarketing", () => {
    expect(descriptionOf("copy_campaign")).toContain("SUGIRA excluir quem já converteu");
  });

  it("regenerate_copy: distingue de adjust_draft (regenera tudo × edita 1 anúncio)", () => {
    expect(descriptionOf("regenerate_copy")).toContain("adjust_draft (copyEdits)");
  });

  function schemaFieldDescriptionOf(toolName: string, field: string): string | undefined {
    const { deps } = makeDeps(() => null);
    const found = makeConversationTools(deps, CTX, WRITE_CREATE_TOOL_NAMES).find((t) => t.name === toolName)! as unknown as {
      schema: { shape: Record<string, { description?: string }> };
    };
    return found.schema.shape[field]?.description;
  }

  it("copy_campaign.interests: NÃO afirma mais que a cópia não herda (achado da revisão da Fase 1 — o código herda por padrão)", () => {
    const d = schemaFieldDescriptionOf("copy_campaign", "interests")!;
    expect(d).not.toContain("não herda");
    expect(d).toContain("JÁ HERDA");
  });

  it("adjust_draft.variantsCount: description migrada do system prompt removido (S0a) — comportamento de aumentar nº de anúncios", () => {
    const d = schemaFieldDescriptionOf("adjust_draft", "variantsCount")!;
    expect(d).toContain("AUMENTAR faz EU escolher criativos distintos");
  });
});

describe("mergeConfigUpdatePatches", () => {
  it("mescla set_goal + set_cadence num único patch (multi-campo no mesmo turno)", () => {
    const cur = state({ goals: { targetCPA: 50 } });
    const merged = mergeConfigUpdatePatches(
      [
        { name: "set_goal", args: { targetCPA: 100 } },
        { name: "set_cadence", args: { kind: "twice_daily", hour: 9, secondHour: 17 } },
      ],
      cur,
    );
    expect(merged?.goals?.targetCPA).toBe(100);
    expect(merged?.cadence).toEqual({ kind: "twice_daily", hours: [9, 17] });
  });

  it("uma única chamada = comportamento igual ao patch dela", () => {
    const merged = mergeConfigUpdatePatches([{ name: "set_guardrail", args: { dryRun: false } }], state());
    expect(merged?.guardrails?.dryRun).toBe(false);
  });

  it("ignora chamadas que não são update de config (reseed/playbook) e sem update → null", () => {
    expect(mergeConfigUpdatePatches([{ name: "reseed_archetype", args: { archetype: "otimizador" } }], state())).toBeNull();
  });
});

describe("playbookOpFromToolCall", () => {
  it("add: monta a regra com then (adjust_budget precisa de budgetChangePct)", () => {
    const op = playbookOpFromToolCall("add_playbook_rule", {
      scope: "ad",
      metric: "cpa",
      op: ">",
      value: 30,
      minSpend: 50,
      thenAction: "adjust_budget",
      budgetChangePct: -20,
    });
    expect(op).toEqual({
      kind: "add",
      rule: { scope: "ad", metric: "cpa", op: ">", value: 30, minSpend: 50, then: { type: "adjust_budget", budgetChangePct: -20 } },
    });
  });

  it("add adjust_budget sem budgetChangePct → null (não vira regra inválida)", () => {
    const op = playbookOpFromToolCall("add_playbook_rule", { scope: "ad", metric: "cpa", op: ">", value: 30, thenAction: "adjust_budget" });
    expect(op).toBeNull();
  });

  it("toggle: carrega ruleId + enabled", () => {
    expect(playbookOpFromToolCall("toggle_playbook_rule", { ruleId: "r1", enabled: false })).toEqual({
      kind: "toggle",
      ruleId: "r1",
      enabled: false,
    });
  });

  it("remove: carrega ruleId", () => {
    expect(playbookOpFromToolCall("remove_playbook_rule", { ruleId: "r2" })).toEqual({ kind: "remove", ruleId: "r2" });
  });
});

describe("ruleRowToDescriptor", () => {
  it("achata a linha do banco no descritor neutro (metric numérico → string)", () => {
    const d = ruleRowToDescriptor({
      scope: "campaign",
      whenJson: { metric: "roas", op: "<", value: 2, minSpend: 100 },
      thenJson: { type: "pause_entity" },
    });
    expect(d).toEqual({ scope: "campaign", metric: "roas", op: "<", value: 2, minSpend: 100, thenType: "pause_entity", budgetChangePct: null, status: null });
  });
});

describe("reject tool", () => {
  it("resolve como rejeitada (sem escrever na Meta)", async () => {
    const { deps, resolve } = makeDeps((id) => (id === "ap-1" ? pending("ap-1") : null));
    await toolOf(deps, "reject").invoke({ approvalIds: ["ap-1"] });
    expect(resolve).toHaveBeenCalledWith("ap-1", { status: "rejected" });
  });

  it("já resolvida (não-pendente) → ignora", async () => {
    const { deps, resolve } = makeDeps(() => ({ id: "ap-1", orgId: "org-1", status: "approved" }));
    await toolOf(deps, "reject").invoke({ approvalIds: ["ap-1"] });
    expect(resolve).not.toHaveBeenCalled();
  });
});

describe("buildCapabilitiesText — criação (fix: honesto, condicional às bindings reais)", () => {
  function fakeCapabilitiesDeps() {
    return {
      db: { select: () => ({ from: () => ({ where: () => ({ limit: async () => [{ autonomyPolicy: { bySource: { playbook: "suggest", llm: "suggest" } } }] }) }) }) },
    } as never;
  }

  it("scale_winner E create_campaign habilitados → menciona os dois + o OK antes de ir ao ar", async () => {
    const text = await buildCapabilitiesText(fakeCapabilitiesDeps(), CTX, new Set(["scale_winner", "create_campaign"]));
    expect(text).toContain("campanhas novas");
    expect(text).toContain("o que já vai bem");
    expect(text).toContain("antes de qualquer coisa ir ao ar");
  });

  it("NENHUM habilitado → NÃO afirma que cria/escala (honestidade — só menciona o habilitado)", async () => {
    const text = await buildCapabilitiesText(fakeCapabilitiesDeps(), CTX, new Set());
    expect(text).not.toContain("campanhas novas");
    expect(text).not.toContain("o que já vai bem");
  });

  it("só scale_winner habilitado → menciona só escalar", async () => {
    const text = await buildCapabilitiesText(fakeCapabilitiesDeps(), CTX, new Set(["scale_winner"]));
    expect(text).toContain("o que já vai bem");
    expect(text).not.toContain("campanhas novas");
  });

  it("só create_campaign habilitado → menciona só criar", async () => {
    const text = await buildCapabilitiesText(fakeCapabilitiesDeps(), CTX, new Set(["create_campaign"]));
    expect(text).not.toContain("o que já vai bem");
    expect(text).toContain("campanhas novas");
  });
});

describe("buildCapabilitiesText — resumo curto e humano (não um manual)", () => {
  function fakeCapabilitiesDeps() {
    return {
      db: { select: () => ({ from: () => ({ where: () => ({ limit: async () => [{}] }) }) }) },
    } as never;
  }

  it("abre pela leitura da conta e é enxuto (poucas linhas, com oferta de detalhar)", async () => {
    const text = await buildCapabilitiesText(fakeCapabilitiesDeps(), CTX, new Set());
    expect(text).toContain("Roy"); // se apresenta pelo nome (DESIGN §5)
    expect(text).toContain("Leio sua conta");
    expect(text).toContain("período que você quiser");
    expect(text).toContain("Quer que eu entre em detalhe");
    // S2: declara o planejamento inerente (consultivo, sempre presente — não depende de binding).
    expect(text).toContain("penso à frente com você");
    expect(text).toContain("sequência de próximos passos");
    // enxuto: não é a parede antiga de 10+ blocos (planejamento fundido na linha de análise)
    expect(text.split("\n").length).toBeLessThanOrEqual(9);
  });

  it("declara o aprendizado; confirmar por chat vira 'pelo site' com o kill-switch OFF", async () => {
    const off = await buildCapabilitiesText(fakeCapabilitiesDeps(), CTX, new Set());
    expect(off).toContain("aprendendo os padrões da sua conta");
    expect(off).toContain("confirmar/corrigir é pelo site");

    const on = await buildCapabilitiesText(
      fakeCapabilitiesDeps(),
      { ...CTX, configViaChat: true },
      new Set([CONFIRM_LEARNING_TOOL_NAME]),
    );
    expect(on).toContain("aprendendo os padrões da sua conta");
    expect(on).toContain("confirmar ou me corrigir por aqui");
  });
});

describe("aprendizado no chat (S7): list_learnings sempre; confirm_learning gated pelo kill-switch", () => {
  it("list_learnings entra na base em contexto (DM + grupo); confirm_learning só em CONFIG_CHAT", () => {
    // leitura do aprendizado = sempre disponível com conta em contexto (DM e grupo).
    expect(AGENT_TOOL_NAMES.has("list_learnings")).toBe(true);
    expect(GROUP_CONCIERGE_TOOL_NAMES.has("list_learnings")).toBe(true);
    // confirmar = config-por-chat (gated pelo kill-switch autoConfigViaChat), nunca na base.
    expect(CONFIG_CHAT_TOOL_NAMES.has(CONFIRM_LEARNING_TOOL_NAME)).toBe(true);
    expect(AGENT_TOOL_NAMES.has(CONFIRM_LEARNING_TOOL_NAME)).toBe(false);
    // concierge (sem foco) não confirma nem lê aprendizado.
    expect(CONCIERGE_TOOL_NAMES.has("list_learnings")).toBe(false);
    expect(CONCIERGE_TOOL_NAMES.has(CONFIRM_LEARNING_TOOL_NAME)).toBe(false);
  });

  /** db falso: select→[row?]; update→espia o set. */
  function learningDb(row: unknown, updateSpy = vi.fn()) {
    const chain: Record<string, unknown> = {
      select: () => chain,
      from: () => chain,
      where: () => chain,
      limit: async () => (row ? [row] : []),
      update: () => ({ set: (v: unknown) => { updateSpy(v); return { where: async () => {} }; } }),
    };
    return chain as never;
  }
  function confirmTool(deps: never, ctx: ConversationToolContext) {
    return makeConversationTools(deps, ctx, CONFIG_CHAT_TOOL_NAMES).find(
      (t) => t.name === CONFIRM_LEARNING_TOOL_NAME,
    )! as unknown as { invoke: (a: unknown) => Promise<string> };
  }

  it("kill-switch OFF → responde 'pelo site' e NÃO toca o db", async () => {
    const { deps } = makeDeps(() => null);
    const update = vi.fn();
    (deps as { db: unknown }).db = learningDb({ id: "m1", confidence: 0.5, content: "x" }, update);
    const out = await confirmTool(deps, { ...CTX, configViaChat: false }).invoke({ learningId: "m1" });
    expect(out.toLowerCase()).toContain("site");
    expect(update).not.toHaveBeenCalled();
  });

  it("kill-switch ON + achou → marca confirmedByHuman e sobe a confiança", async () => {
    const { deps } = makeDeps(() => null);
    const update = vi.fn();
    (deps as { db: unknown }).db = learningDb({ id: "m1", confidence: 0.5, content: "campanha X é zumbi" }, update);
    const out = await confirmTool(deps, { ...CTX, configViaChat: true }).invoke({ learningId: "m1" });
    expect(update).toHaveBeenCalledTimes(1);
    const patch = update.mock.calls[0]![0] as { confirmedByHuman: boolean; confidence: number; lifecycle: string };
    expect(patch.confirmedByHuman).toBe(true);
    expect(patch.lifecycle).toBe("active");
    expect(patch.confidence).toBeGreaterThan(0.5);
    expect(out.toLowerCase()).toContain("confirmado");
  });

  it("kill-switch ON + não achou → erro amigável da casca compartilhada, sem update (F-chat-3)", async () => {
    const { deps } = makeDeps(() => null);
    const update = vi.fn();
    (deps as { db: unknown }).db = learningDb(null, update);
    const out = await confirmTool(deps, { ...CTX, configViaChat: true }).invoke({ learningId: "nope" });
    expect(update).not.toHaveBeenCalled();
    // agora reusa @trafego/agent-config (mesma mensagem do site) em vez de texto inline do chat.
    expect(out.toLowerCase()).toContain("não encontrado");
  });
});
