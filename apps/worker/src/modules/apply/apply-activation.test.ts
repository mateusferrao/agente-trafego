import { describe, expect, it } from "vitest";
import { entitiesToActivate } from "./apply-activation.js";

describe("entitiesToActivate (ativa a árvore inteira — a Meta não cascateia status)", () => {
  it("from_scratch → campanha + adset + TODOS os ads (senão a árvore trava pausada)", () => {
    expect(
      entitiesToActivate({
        kind: "from_scratch",
        createdIds: { campaignId: "C1", adsetId: "AS1", adIds: ["AD1", "AD2"] },
        sourceRef: null,
      }),
    ).toEqual([
      { level: "campaign", id: "C1" },
      { level: "adset", id: "AS1" },
      { level: "ad", id: "AD1" },
      { level: "ad", id: "AD2" },
    ]);
  });

  it("duplicate de ADSET → a cópia (adset) + os ads copiados (campanha-mãe já ativa)", () => {
    expect(
      entitiesToActivate({
        kind: "duplicate",
        createdIds: { copiedId: "AS_NEW", childIds: ["AD1_NEW", "AD2_NEW"], childAdsetIds: [] },
        sourceRef: { level: "adset", id: "AS_SRC" },
      }),
    ).toEqual([
      { level: "adset", id: "AS_NEW" },
      { level: "ad", id: "AD1_NEW" },
      { level: "ad", id: "AD2_NEW" },
    ]);
  });

  it("duplicate de CAMPANHA → a cópia (campanha) + adsets intermediários + ads (todos travariam)", () => {
    expect(
      entitiesToActivate({
        kind: "duplicate",
        createdIds: { copiedId: "C_NEW", childAdsetIds: ["AS_NEW"], childIds: ["AD_NEW"] },
        sourceRef: { level: "campaign", id: "C_SRC" },
      }),
    ).toEqual([
      { level: "campaign", id: "C_NEW" },
      { level: "adset", id: "AS_NEW" },
      { level: "ad", id: "AD_NEW" },
    ]);
  });

  it("ids ausentes (shape parcial) → lista vazia (o caller bloqueia, não ativa às cegas)", () => {
    expect(entitiesToActivate({ kind: "from_scratch", createdIds: {}, sourceRef: null })).toEqual([]);
    expect(
      entitiesToActivate({ kind: "duplicate", createdIds: { childIds: ["X"] }, sourceRef: null }),
    ).toEqual([{ level: "ad", id: "X" }]); // sem copiedId/level → só os ads conhecidos
  });
});
