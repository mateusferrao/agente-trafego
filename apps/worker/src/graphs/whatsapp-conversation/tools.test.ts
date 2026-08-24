import { describe, expect, it, vi } from "vitest";
import { APPROVAL_APPLY_QUEUE } from "@trafego/shared";
import type { AgentConfigState } from "@trafego/core";
import type { GuardrailConfig, AutonomyPolicy, NotifyPolicy } from "@trafego/shared";
import {
  AGENT_TOOL_NAMES,
  CONCIERGE_TOOL_NAMES,
  actionFromToolCall,
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
  });

  it("reflete o contexto: escrita só quando habilitada + config conforme o kill-switch", async () => {
    const { deps } = makeDeps(() => null);
    (deps as { db: unknown }).db = dbWithAutonomy("suggest", "notify");

    const on = await capTool(deps, { ...CTX, configViaChat: true }, new Set(["describe_capabilities", "pause_entity"])).invoke({});
    expect(on).toContain("pausar");
    expect(on).toContain("Mudar a config");
    expect(on).toContain("sugiro e peço seu OK"); // autonomia playbook em PT
    expect(on.toLowerCase()).toContain("panorama");

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

  it("adjust_budget set → converte reais → amountMinor (centavos)", () => {
    const a = actionFromToolCall("adjust_budget", args({ mode: "set", amountReais: 200 }), "tc2");
    expect(a?.params).toEqual({ mode: "set", amountMinor: 20000 });
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

  it("set sem amountReais → null (não vira ação inválida)", () => {
    expect(actionFromToolCall("adjust_budget", args({ mode: "set" }), "x")).toBeNull();
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
    ...over,
  };
}

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

  it("set_persona: texto vira patch; identidade não é goal/guardrail", () => {
    const patch = configPatchFromToolCall("set_persona", { text: "vendedor consultivo" }, state());
    expect(patch).toEqual({ persona: "vendedor consultivo" });
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
