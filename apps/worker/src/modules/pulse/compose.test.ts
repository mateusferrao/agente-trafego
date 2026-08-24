import { describe, expect, it } from "vitest";
import { composePulseOverview, type PulseRunData } from "./compose.js";

const base: PulseRunData = {
  accountName: "Clínica X",
  summary: "Conta gastou R$ 500 essa semana.",
  snapshot: { scorecard: { headline: "CPA acima da meta." }, waste: { wastedSpend: 12000, wastedPct: 24 } },
  recommendationTitles: ["Pausar campanha zumbi"],
};

describe("composePulseOverview", () => {
  it("monta overview com money-shot a partir do último run", () => {
    const o = composePulseOverview(base);
    expect(o).toEqual({
      accountName: "Clínica X",
      headline: "CPA acima da meta.",
      summary: "Conta gastou R$ 500 essa semana.",
      recommendations: [{ title: "Pausar campanha zumbi" }],
      money: { wastedSpend: 12000, wastedPct: 24 },
    });
  });

  it("omite money quando não há desperdício material", () => {
    const o = composePulseOverview({ ...base, snapshot: { scorecard: { headline: "Tudo ok." }, waste: { wastedSpend: 0 } } });
    expect(o).not.toHaveProperty("money");
  });

  it("run sem síntese (nem headline nem summary) → null (não manda pulso)", () => {
    expect(composePulseOverview({ ...base, summary: null, snapshot: null })).toBeNull();
  });
});
