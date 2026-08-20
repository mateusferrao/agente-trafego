import { AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages";
import { describe, expect, it } from "vitest";
import { windowMessages } from "./window.js";

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
