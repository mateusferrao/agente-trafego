import { describe, expect, it, vi } from "vitest";
import { AIMessage } from "@langchain/core/messages";
import { assembleSystemPrompt, currentDateTimeLine, drainPendingCostPatches, needsCostFallback, patchCostInBackground, routeConversation, scheduleCostPatch } from "./nodes.js";
import { GROUP_RULES } from "./system-prompt.js";
import {
  CONFIG_UPDATE_TOOL_NAMES,
  CONTROL_WRITE_TOOL_NAMES,
  CREATE_TOOL_NAMES,
  EDIT_AUDIENCE_TOOL_NAME,
  REALLOCATE_TOOL_NAME,
  REFINE_TOOL_NAMES,
  REVERT_TOOL_NAME,
  WRITE_TOOL_NAMES,
} from "./tools.js";
import type { WhatsappConversationStateType } from "./state.js";

function stateWith(toolCalls: { name: string; args?: Record<string, unknown> }[]): WhatsappConversationStateType {
  const msg = new AIMessage({ content: "", tool_calls: toolCalls.map((t, i) => ({ id: `c${i}`, name: t.name, args: t.args ?? {} })) });
  return { messages: [msg] } as WhatsappConversationStateType;
}

describe("routeConversation", () => {
  it("sem tool call → END", () => {
    expect(routeConversation({ messages: [new AIMessage("oi")] } as WhatsappConversationStateType)).toBe("__end__");
  });
  it("tool de leitura → tools", () => {
    expect(routeConversation(stateWith([{ name: "get_metrics" }]))).toBe("tools");
  });
  it("tool de escrita livre → confirm (eco+confirma)", () => {
    expect(routeConversation(stateWith([{ name: "pause_entity" }]))).toBe("confirm");
  });
  it("confirm_write → apply", () => {
    expect(routeConversation(stateWith([{ name: "confirm_write" }]))).toBe("apply");
  });
  it("revert_action → confirm (desfazer também é escrita)", () => {
    expect(routeConversation(stateWith([{ name: "revert_action" }]))).toBe("confirm");
  });
  it("cancel_write → apply", () => {
    expect(routeConversation(stateWith([{ name: "cancel_write" }]))).toBe("apply");
  });
  it("tool de config (set_goal) → confirm (eco+confirma)", () => {
    expect(routeConversation(stateWith([{ name: "set_goal" }]))).toBe("confirm");
  });
  it("reseed_archetype → confirm", () => {
    expect(routeConversation(stateWith([{ name: "reseed_archetype" }]))).toBe("confirm");
  });
  it("add_playbook_rule → confirm", () => {
    expect(routeConversation(stateWith([{ name: "add_playbook_rule" }]))).toBe("confirm");
  });
  it("list_playbook_rules (leitura) → tools", () => {
    expect(routeConversation(stateWith([{ name: "list_playbook_rules" }]))).toBe("tools");
  });
  it("describe_capabilities → confirm (emitido verbatim, sem paráfrase do LLM)", () => {
    expect(routeConversation(stateWith([{ name: "describe_capabilities" }]))).toBe("confirm");
  });
  it("edit_audience → confirm (A1 — escrita opt-in, eco+confirma)", () => {
    expect(routeConversation(stateWith([{ name: "edit_audience" }]))).toBe("confirm");
  });
  it("reallocate_budget → confirm (A4 — saga A→B, eco+confirma)", () => {
    expect(routeConversation(stateWith([{ name: "reallocate_budget" }]))).toBe("confirm");
  });
});

// D1: invariante de segurança do flip da flag — NENHUMA tool de escrita/criação/refino/config
// pode ir direto pro "apply" (auto-aplicar). SÓ o controle explícito confirm_write/cancel_write
// (que aplica o CONGELADO após o "sim") roteia pra "apply". Toda escrita passa pelo eco+confirma.
describe("routeConversation — invariante anti-auto-apply (bateria D1 do flip)", () => {
  const writeishTools = [
    ...WRITE_TOOL_NAMES,
    ...CREATE_TOOL_NAMES,
    ...REFINE_TOOL_NAMES,
    ...CONFIG_UPDATE_TOOL_NAMES,
    EDIT_AUDIENCE_TOOL_NAME,
    REALLOCATE_TOOL_NAME,
    REVERT_TOOL_NAME,
  ].filter((n) => !CONTROL_WRITE_TOOL_NAMES.has(n));

  it.each(writeishTools)("%s → confirm (nunca apply direto)", (name) => {
    expect(routeConversation(stateWith([{ name }]))).toBe("confirm");
  });

  it.each([...CONTROL_WRITE_TOOL_NAMES])("%s → apply (aplica o congelado após o sim)", (name) => {
    expect(routeConversation(stateWith([{ name }]))).toBe("apply");
  });

  it("escrita + controle no MESMO turno → apply vence (o sim resolve o congelado; escrita nova ignorada)", () => {
    // se o LLM emitir pause_entity + confirm_write juntos, o controle tem prioridade — não
    // reabre uma escrita nova sem eco (o congelado é a fonte da verdade).
    expect(routeConversation(stateWith([{ name: "pause_entity" }, { name: "confirm_write" }]))).toBe("apply");
  });

  it("tool de leitura + escrita no mesmo turno → confirm (a escrita exige eco antes de tudo)", () => {
    expect(routeConversation(stateWith([{ name: "get_metrics" }, { name: "adjust_budget" }]))).toBe("confirm");
  });
});

describe("currentDateTimeLine (data/hora no fuso da org)", () => {
  it("formata 'agora' no fuso da org (não UTC) e instrui uso temporal", () => {
    // 12:00 UTC = 09:00 em São Paulo (UTC-3).
    const line = currentDateTimeLine("America/Sao_Paulo", new Date("2026-08-27T12:00:00Z"));
    expect(line).toContain("America/Sao_Paulo");
    expect(line).toContain("09:00");
    expect(line).toContain("2026");
    expect(line.toLowerCase()).toContain("momento presente");
  });
});

describe("assembleSystemPrompt (injeção do contexto de grupo)", () => {
  const VOZ = "Você é o assistente.";

  it("DM (groupBlock vazio, sem eco) → prompt IDÊNTICO à voz (regressão byte a byte)", () => {
    expect(assembleSystemPrompt(VOZ, "", undefined)).toBe(VOZ);
  });

  it("grupo → injeta o transcript entre a voz e o (eventual) eco", () => {
    const block = "### Conversa recente do grupo (contexto...)\nJoão [24/08 14:32]: oi";
    const out = assembleSystemPrompt(VOZ, block, undefined);
    expect(out).toBe(`${VOZ}\n\n${block}`);
  });

  it("eco+confirma preservado; em DM o eco vem logo após a voz (sem bloco de grupo)", () => {
    const out = assembleSystemPrompt(VOZ, "", "vou pausar a Campanha X, confirma?");
    expect(out.startsWith(VOZ)).toBe(true);
    expect(out).toContain("aguarda a confirmação do usuário");
    expect(out).toContain("vou pausar a Campanha X, confirma?");
    expect(out).toContain("chame confirm_write");
  });

  it("grupo + eco: ordem = voz → transcript → eco", () => {
    const block = "### Conversa recente do grupo\nMaria [24/08 15:00]: e a conta B?";
    const out = assembleSystemPrompt(VOZ, block, "vou reativar a Campanha Y, confirma?");
    expect(out.indexOf(block)).toBeLessThan(out.indexOf("aguarda a confirmação"));
    expect(out.indexOf(VOZ)).toBeLessThan(out.indexOf(block));
  });
});

describe("GROUP_RULES (S5 — comportamentos de grupo)", () => {
  it("cobre: só responde quando dirigido, contexto = histórico, anti-vigilância", () => {
    expect(GROUP_RULES).toContain("DIRIGIDO");
    expect(GROUP_RULES).toContain("Conversa recente do grupo");
    expect(GROUP_RULES).toContain("NÃO trate uma fala antiga");
    expect(GROUP_RULES.toLowerCase()).toContain("vigilante");
  });

  it("cobre: grounding da conta (nomear/inferir/confirmar) e honestidade de mídia", () => {
    expect(GROUP_RULES).toContain("DE QUAL CONTA");
    expect(GROUP_RULES).toContain("INFIRA");
    expect(GROUP_RULES).toContain("eco+confirma");
    expect(GROUP_RULES).toContain("NÃO enxerga imagens");
    expect(GROUP_RULES.toLowerCase()).toContain("áudio enviado diretamente a você".toLowerCase());
  });
});

const fakeLogger = { debug: vi.fn() };

describe("needsCostFallback", () => {
  it("false quando o custo já veio direto (não precisa consultar nada)", () => {
    expect(needsCostFallback({ costUsd: 0.001 }, "gen-1")).toBe(false);
  });

  it("false quando não há generation id pra consultar", () => {
    expect(needsCostFallback({}, undefined)).toBe(false);
  });

  it("true quando falta custo e há id", () => {
    expect(needsCostFallback({}, "gen-1")).toBe(true);
  });
});

describe("patchCostInBackground", () => {
  it("espera (sleepFn) antes de consultar, e faz o PATCH quando acha o custo", async () => {
    const order: string[] = [];
    const sleepFn = vi.fn(async () => {
      order.push("sleep");
    });
    const fetchGenerationCost = vi.fn(async () => {
      order.push("fetch");
      return 0.0034;
    });
    const updateCost = vi.fn(async () => {
      order.push("update");
    });

    await patchCostInBackground({
      usageEventId: "usage-1",
      generationId: "gen-1",
      fetchGenerationCost,
      updateCost,
      logger: fakeLogger,
      sleepFn,
    });

    expect(order).toEqual(["sleep", "fetch", "update"]);
    expect(fetchGenerationCost).toHaveBeenCalledWith("gen-1");
    expect(updateCost).toHaveBeenCalledWith("usage-1", 0.0034);
  });

  it("custo ainda indisponível em todas as tentativas → desiste sem PATCH, sem lançar (5 tentativas)", async () => {
    const sleepFn = vi.fn(async () => {});
    const fetchGenerationCost = vi.fn(async () => undefined);
    const updateCost = vi.fn(async () => {});

    await patchCostInBackground({
      usageEventId: "usage-1",
      generationId: "gen-1",
      fetchGenerationCost,
      updateCost,
      logger: fakeLogger,
      sleepFn,
    });

    expect(fetchGenerationCost).toHaveBeenCalledTimes(5);
    expect(updateCost).not.toHaveBeenCalled();
  });

  it("indisponível nas 2 primeiras, acha na 3ª tentativa → PATCH e para de tentar", async () => {
    const sleepFn = vi.fn(async () => {});
    let calls = 0;
    const fetchGenerationCost = vi.fn(async () => {
      calls += 1;
      return calls < 3 ? undefined : 0.0056;
    });
    const updateCost = vi.fn(async () => {});

    await patchCostInBackground({
      usageEventId: "usage-1",
      generationId: "gen-1",
      fetchGenerationCost,
      updateCost,
      logger: fakeLogger,
      sleepFn,
    });

    expect(fetchGenerationCost).toHaveBeenCalledTimes(3);
    expect(updateCost).toHaveBeenCalledTimes(1);
    expect(updateCost).toHaveBeenCalledWith("usage-1", 0.0056);
  });

  it("fetch lança → engolido, sem PATCH, sem propagar erro", async () => {
    const sleepFn = vi.fn(async () => {});
    const fetchGenerationCost = vi.fn(async () => {
      throw new Error("boom");
    });
    const updateCost = vi.fn(async () => {});

    await expect(
      patchCostInBackground({
        usageEventId: "usage-1",
        generationId: "gen-1",
        fetchGenerationCost,
        updateCost,
        logger: fakeLogger,
        sleepFn,
      }),
    ).resolves.toBeUndefined();
    expect(updateCost).not.toHaveBeenCalled();
  });
});

describe("drainPendingCostPatches", () => {
  it("nada agendado → resolve na hora", async () => {
    await expect(drainPendingCostPatches()).resolves.toBeUndefined();
  });

  it("espera o job agendado terminar (dentro do teto)", async () => {
    const updateCost = vi.fn(async () => {});
    scheduleCostPatch({
      usageEventId: "usage-1",
      generationId: "gen-1",
      fetchGenerationCost: vi.fn(async () => 0.002),
      updateCost,
      logger: fakeLogger,
      sleepFn: vi.fn(async () => {}), // sem espera real neste teste
    });

    await drainPendingCostPatches(1000);

    expect(updateCost).toHaveBeenCalledWith("usage-1", 0.002);
  });

  it("job travado (nunca termina) → drain desiste no teto, sem travar o teste", async () => {
    scheduleCostPatch({
      usageEventId: "usage-2",
      generationId: "gen-2",
      fetchGenerationCost: vi.fn(async () => undefined),
      updateCost: vi.fn(async () => {}),
      logger: fakeLogger,
      sleepFn: () => new Promise(() => {}), // nunca resolve
    });

    await expect(drainPendingCostPatches(10)).resolves.toBeUndefined();
  });
});
