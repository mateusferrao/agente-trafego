import { AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages";
import { describe, expect, it } from "vitest";
import { sanitizeToolPairs, windowMessages } from "./window.js";

/** Um turno de leitura: fala → AI(tool_call) → ToolMessage → AI(resposta). */
function toolTurn(userText: string, toolId: string): [HumanMessage, AIMessage, ToolMessage, AIMessage] {
  return [
    new HumanMessage(userText),
    new AIMessage({ content: "", tool_calls: [{ id: toolId, name: "get_metrics", args: {} }] }),
    new ToolMessage({ content: "resultado", tool_call_id: toolId }),
    new AIMessage("aqui está"),
  ];
}

describe("windowMessages", () => {
  it("mantém só os últimos N turnos", () => {
    const msgs = [
      new HumanMessage("t1"),
      new AIMessage("r1"),
      new HumanMessage("t2"),
      new AIMessage("r2"),
      new HumanMessage("t3"),
      new AIMessage("r3"),
    ];
    const out = windowMessages(msgs, { maxTurns: 2, maxTokens: 10_000 });
    expect(out.map((m) => m.content)).toEqual(["t2", "r2", "t3", "r3"]);
  });

  it("nunca quebra o par tool_call/tool_result (mantém o turno inteiro)", () => {
    const msgs = [...toolTurn("t1", "a"), ...toolTurn("t2", "b")];
    const out = windowMessages(msgs, { maxTurns: 1, maxTokens: 10_000 });
    // só o último turno, mas COMPLETO (ai+tool+ai), nunca um ToolMessage órfão.
    expect(out).toHaveLength(4);
    const aiWithCall = out.find((m) => (m as AIMessage).tool_calls?.length);
    const toolMsg = out.find((m) => m instanceof ToolMessage) as ToolMessage | undefined;
    expect(aiWithCall).toBeDefined();
    expect((aiWithCall as AIMessage).tool_calls![0]!.id).toBe(toolMsg!.tool_call_id);
  });

  it("teto de tokens derruba turnos antigos além do N", () => {
    const big = "x".repeat(4000); // ~1000 tokens
    const msgs = [
      new HumanMessage(big),
      new AIMessage(big),
      new HumanMessage("recente"),
      new AIMessage("curta"),
    ];
    const out = windowMessages(msgs, { maxTurns: 5, maxTokens: 500 });
    expect(out.map((m) => m.content)).toEqual(["recente", "curta"]);
  });

  it("mantém ao menos o último turno mesmo se exceder o teto", () => {
    const huge = "y".repeat(8000);
    const out = windowMessages([new HumanMessage(huge), new AIMessage("r")], { maxTurns: 5, maxTokens: 100 });
    expect(out).toHaveLength(2);
  });

  it("menos turnos que N → devolve tudo", () => {
    const msgs = [new HumanMessage("t1"), new AIMessage("r1")];
    expect(windowMessages(msgs, { maxTurns: 8, maxTokens: 10_000 })).toHaveLength(2);
  });
});

describe("sanitizeToolPairs (cura thread envenenado por órfão de tool_call)", () => {
  it("órfão puro (AI tool_call sem ToolMessage, sem texto) → some", () => {
    const msgs = [
      new HumanMessage("qual o whats?"),
      new AIMessage({ content: "", tool_calls: [{ id: "call_x", name: "get_whatsapp_number", args: {} }] }),
    ];
    const out = sanitizeToolPairs(msgs);
    expect(out).toHaveLength(1);
    expect(out[0]!._getType()).toBe("human");
  });

  it("par completo → intacto", () => {
    const msgs = toolTurn("como tá?", "call_ok");
    expect(sanitizeToolPairs(msgs)).toHaveLength(4);
  });

  it("AI com 2 calls, só 1 respondido → tira o órfão, mantém o respondido", () => {
    const msgs = [
      new HumanMessage("faz duas coisas"),
      new AIMessage({ content: "", tool_calls: [{ id: "c1", name: "get_metrics", args: {} }, { id: "c2", name: "get_status", args: {} }] }),
      new ToolMessage({ content: "ok", tool_call_id: "c1" }),
    ];
    const out = sanitizeToolPairs(msgs);
    const ai = out.find((m) => m._getType() === "ai") as AIMessage;
    expect(ai.tool_calls).toHaveLength(1);
    expect(ai.tool_calls![0]!.id).toBe("c1");
    // o ToolMessage de c1 sobrevive; nenhum órfão de resultado.
    expect(out.some((m) => m._getType() === "tool")).toBe(true);
  });

  it("AI com texto + call órfão → mantém a mensagem só com o texto (sem o call)", () => {
    const msgs = [
      new HumanMessage("oi"),
      new AIMessage({ content: "já respondo", tool_calls: [{ id: "orf", name: "x", args: {} }] }),
    ];
    const out = sanitizeToolPairs(msgs);
    const ai = out.find((m) => m._getType() === "ai") as AIMessage;
    expect(ai.tool_calls ?? []).toHaveLength(0);
    expect(ai.content).toBe("já respondo");
  });

  it("ToolMessage órfão (resultado sem call) → descartado", () => {
    const msgs = [new HumanMessage("oi"), new ToolMessage({ content: "resultado solto", tool_call_id: "fantasma" })];
    const out = sanitizeToolPairs(msgs);
    expect(out.some((m) => m._getType() === "tool")).toBe(false);
  });

  it("não mexe em conversa sem tools", () => {
    const msgs = [new HumanMessage("oi"), new AIMessage("olá")];
    expect(sanitizeToolPairs(msgs)).toHaveLength(2);
  });
});
