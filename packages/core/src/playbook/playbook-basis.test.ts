import { describe, expect, it } from "vitest";
import type { ConversionBasis, InsightMetrics, InsightRow, PlaybookRule } from "@trafego/shared";
import { evaluatePlaybook, type EntityConversionResolution } from "./index.js";

const cpaRule: PlaybookRule = {
  id: "rule-cpa",
  enabled: true,
  priority: 10,
  scope: "ad",
  when: { metric: "cpa", op: ">", value: 100, window: "7d", minSpend: 50 },
  then: { type: "pause_entity" },
};

const spendRule: PlaybookRule = {
  id: "rule-spend",
  enabled: true,
  priority: 5,
  scope: "ad",
  when: { metric: "spend", op: ">", value: 100, window: "7d" },
  then: { type: "pause_entity" },
};

function adRow(id: string, spend: number): InsightRow {
  return {
    entityId: id,
    level: "ad",
    metrics: { spend, impressions: 0, clicks: 0, ctr: 0, cpc: 0, cpm: 0 },
  };
}

function resolution(basis: ConversionBasis, cpa?: number): EntityConversionResolution {
  const metrics: InsightMetrics = { spend: 200, impressions: 0, clicks: 0, ctr: 0, cpc: 0, cpm: 0, ...(cpa !== undefined ? { cpa } : {}) };
  return { basis, metrics };
}

describe("evaluatePlaybook — CPA segue o basis", () => {
  const rows = [adRow("ad-target", 200), adRow("ad-proxy", 200), adRow("ad-none", 200)];
  const map = new Map<string, EntityConversionResolution>([
    ["ad:ad-target", resolution("target", 150)],
    ["ad:ad-proxy", resolution("proxy", 150)], // custo existe, mas não é a conversão de negócio
    ["ad:ad-none", resolution("none")],
  ]);

  it("dispara CPA só na entidade `target` (usa o custo de negócio)", () => {
    const actions = evaluatePlaybook([cpaRule], rows, map);
    expect(actions.map((a) => a.target.id)).toEqual(["ad-target"]);
  });

  it("`proxy`/`none` não disparam regra de CPA (honestidade do descasamento)", () => {
    const actions = evaluatePlaybook([cpaRule], [adRow("ad-proxy", 200)], map);
    expect(actions).toHaveLength(0);
  });

  it("métrica sempre-mensurável (spend) dispara independe do basis", () => {
    const actions = evaluatePlaybook([spendRule], rows, map);
    expect(actions.map((a) => a.target.id).sort()).toEqual(["ad-none", "ad-proxy", "ad-target"]);
  });
});
