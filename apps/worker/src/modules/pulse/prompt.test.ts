import { describe, expect, it } from "vitest";
import { buildPulseFallback, buildPulseMessages, PULSE_PERIOD_LABEL, type PulseInput } from "./prompt.js";
import type { FreshKpis } from "../conversation/fresh-metrics.js";

const KPIS: FreshKpis = {
  spend: 500,
  impressions: 10000,
  clicks: 200,
  ctr: 2,
  cpc: 2.5,
  cpm: 50,
  conversions: 40,
  cpa: 12.5,
  roas: null,
};

function input(over: Partial<PulseInput> = {}): PulseInput {
  return {
    accountName: "Clínica X",
    kpis: KPIS,
    updated: true,
    spendDeltaPct: 10,
    cpaLabel: "Custo por venda",
    standingRecs: ["Pausar CAMP-Y", "Escalar ESCALA"],
    noAnalysisYet: false,
    ...over,
  };
}

describe("buildPulseFallback", () => {
  it("declara o período, lidera pelos números e cita as recs que seguem valendo", () => {
    const t = buildPulseFallback(input());
    expect(t).toContain(PULSE_PERIOD_LABEL);
    expect(t).toContain("Clínica X");
    expect(t.toLowerCase()).toContain("custo por venda");
    expect(t).toContain("consolidando"); // ressalva intradiária
    expect(t).toContain("Pausar CAMP-Y");
  });

  it("sem análise → orienta rodar uma análise (não inventa recs)", () => {
    const t = buildPulseFallback(input({ noAnalysisYet: true, standingRecs: [] }));
    expect(t.toLowerCase()).toContain("análise");
    expect(t).not.toContain("•");
  });

  it("não atualizado → avisa que é o último dado sincronizado", () => {
    const t = buildPulseFallback(input({ updated: false }));
    expect(t.toLowerCase()).toContain("último dado sincronizado");
  });
});

describe("buildPulseMessages", () => {
  it("injeta a postura e a instrução de período/ressalva no system", () => {
    const msgs = buildPulseMessages(
      "VOZ",
      { directiveness: "directive", volume: "concise", didacticDepth: "explanatory", experienceLevel: "beginner" },
      input(),
    );
    const system = msgs[0]!.content as string;
    expect(system).toContain("VOZ");
    expect(system.toLowerCase()).toContain("postura");
    expect(system).toContain(PULSE_PERIOD_LABEL);
    // o retrato curado vai no user message como JSON.
    expect(msgs[1]!.content as string).toContain("standingRecommendations");
  });
});
