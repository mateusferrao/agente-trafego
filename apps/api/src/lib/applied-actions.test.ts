import { describe, expect, it } from "vitest";
import { collapseActivationGroups, type AppliedAction } from "./applied-actions.js";

const action = (toolCallId: string, targetLevel: string): AppliedAction => ({
  toolCallId, runId: null, type: "resume_entity", targetLevel, targetId: `${toolCallId}-ent`,
  targetName: null, simulated: false, reverted: false, undoable: true, revertBlocked: false, revertBlockedReason: null,
});

describe("collapseActivationGroups", () => {
  it("uma ativação (campanha+conjuntos+anúncios) → 1 item: a campanha (raiz)", () => {
    const actions = [
      action("tc-camp", "campaign"), action("tc-as1", "adset"), action("tc-as2", "adset"),
      action("tc-ad1", "ad"), action("tc-ad2", "ad"),
    ];
    const idemp = new Map([
      ["tc-camp", "draft:D1:activate:C"], ["tc-as1", "draft:D1:activate:AS1"], ["tc-as2", "draft:D1:activate:AS2"],
      ["tc-ad1", "draft:D1:activate:AD1"], ["tc-ad2", "draft:D1:activate:AD2"],
    ]);
    const out = collapseActivationGroups(actions, idemp);
    expect(out.map((a) => a.toolCallId)).toEqual(["tc-camp"]);
    expect(out[0]!.targetLevel).toBe("campaign");
  });

  it("duas ativações distintas → 1 item por ativação", () => {
    const actions = [action("a-camp", "campaign"), action("a-ad", "ad"), action("b-camp", "campaign"), action("b-ad", "ad")];
    const idemp = new Map([
      ["a-camp", "draft:DA:activate:C"], ["a-ad", "draft:DA:activate:AD"],
      ["b-camp", "draft:DB:activate:C"], ["b-ad", "draft:DB:activate:AD"],
    ]);
    expect(collapseActivationGroups(actions, idemp).map((a) => a.toolCallId).sort()).toEqual(["a-camp", "b-camp"]);
  });

  it("ativação de conjunto-raiz (sem campanha) → o conjunto vira a raiz", () => {
    const actions = [action("tc-as", "adset"), action("tc-ad", "ad")];
    const idemp = new Map([["tc-as", "draft:D2:activate:AS"], ["tc-ad", "draft:D2:activate:AD"]]);
    expect(collapseActivationGroups(actions, idemp).map((a) => a.toolCallId)).toEqual(["tc-as"]);
  });

  it("ações que NÃO são de ativação passam inalteradas (preserva ordem)", () => {
    const actions = [action("pause-1", "campaign"), action("act-camp", "campaign"), action("act-ad", "ad"), action("budget-1", "adset")];
    const idemp = new Map([
      ["pause-1", "pause:xyz"], ["act-camp", "draft:D3:activate:C"], ["act-ad", "draft:D3:activate:AD"], ["budget-1", "scale:abc"],
    ]);
    expect(collapseActivationGroups(actions, idemp).map((a) => a.toolCallId)).toEqual(["pause-1", "act-camp", "budget-1"]);
  });
});
