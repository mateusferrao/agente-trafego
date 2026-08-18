import { describe, expect, it } from "vitest";
import type { InsightRow, PlaybookRule } from "@trafego/shared";
import { evaluatePlaybook } from "./index.js";

const pauseExpensiveAd: PlaybookRule = {
  id: "rule-cpa",
  enabled: true,
  priority: 10,
  scope: "ad",
  when: { metric: "cpa", op: ">", value: 100, window: "7d", minSpend: 50 },
  then: { type: "pause_entity" },
};

function adRow(id: string, metrics: Partial<InsightRow["metrics"]>): InsightRow {
  return {
    entityId: id,
    level: "ad",
    metrics: {
      spend: 0,
      impressions: 0,
      clicks: 0,
      ctr: 0,
      cpc: 0,
      cpm: 0,
      ...metrics,
    },
  };
}

describe("evaluatePlaybook", () => {
  it("gera ação quando a condição vale e há spend suficiente", () => {
    const rows = [adRow("ad-1", { spend: 200, cpa: 150 })];
    const actions = evaluatePlaybook([pauseExpensiveAd], rows);

    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({
      type: "pause_entity",
      source: "playbook",
      ruleId: "rule-cpa",
      target: { level: "ad", id: "ad-1" },
    });
  });

  it("respeita minSpend (não dispara abaixo do gasto mínimo)", () => {
    const rows = [adRow("ad-2", { spend: 10, cpa: 999 })];
    expect(evaluatePlaybook([pauseExpensiveAd], rows)).toHaveLength(0);
  });

  it("ignora regras desabilitadas e entidades de outro nível", () => {
    const disabled: PlaybookRule = { ...pauseExpensiveAd, enabled: false };
    const rows = [adRow("ad-3", { spend: 200, cpa: 150 })];
    expect(evaluatePlaybook([disabled], rows)).toHaveLength(0);

    const campaignRow: InsightRow = { ...adRow("camp-1", { spend: 200, cpa: 150 }), level: "campaign" };
    expect(evaluatePlaybook([pauseExpensiveAd], [campaignRow])).toHaveLength(0);
  });
});
