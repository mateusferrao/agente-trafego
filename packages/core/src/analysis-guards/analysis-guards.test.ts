import { describe, expect, it } from "vitest";
import type { AccountBrief, AnalysisOutput } from "@trafego/shared";
import { dropUnsupportedFindings, flagUnsupportedFindings } from "./index.js";

const brief = {
  account: { id: "act_1", name: "Conta", currency: "BRL", window: "7d", baselineWindow: "7d ant." },
  goals: { targetCPA: 50 },
  totals: { spend: 300, impressions: 10000, clicks: 200, ctr: 2, cpc: 1.5, cpm: 30, delta: {} },
  trends: [],
  segments: {
    campaigns: [
      { id: "c1", level: "campaign", name: "C1", status: "active", metrics: { spend: 100, impressions: 4000, clicks: 80, ctr: 2, cpc: 1.25, cpm: 25, cpa: 100 }, deltaVsBaseline: {}, flags: [] },
    ],
    adsets: [],
    ads: [],
  },
  anomalies: [],
  creatives: [],
  playbookCandidates: [],
  memory: { objectives: [], pastActions: [], rejected: [] },
  aggregatesRest: { count: 0, spend: 0 },
} as unknown as AccountBrief;

function output(findings: AnalysisOutput["findings"]): AnalysisOutput {
  return {
    scorecard: { grade: "B", headline: "x", biggestLeak: "conversao" },
    summary: "s",
    findings,
    recommendations: [],
  };
}

describe("analysis-guards", () => {
  it("mantém finding com número que existe no brief", () => {
    const out = output([{ id: "f1", title: "CPA alto", detail: "CPA 100", severity: "warning", metricRefs: [{ label: "CPA", value: 100 }], caveat: null }]);
    expect(flagUnsupportedFindings(out, brief)).toHaveLength(0);
    expect(dropUnsupportedFindings(out, brief).findings).toHaveLength(1);
  });

  it("descarta finding sem metricRefs (hard)", () => {
    const out = output([{ id: "f1", title: "algo", detail: "sem número", severity: "info", metricRefs: [], caveat: null }]);
    expect(flagUnsupportedFindings(out, brief)[0]?.reason).toBe("no_metric_ref");
    expect(dropUnsupportedFindings(out, brief).findings).toHaveLength(0);
  });

  it("descarta finding cujo número não existe no brief (alucinação)", () => {
    const out = output([{ id: "f1", title: "CPA", detail: "CPA 999", severity: "warning", metricRefs: [{ label: "CPA", value: 999 }], caveat: null }]);
    expect(flagUnsupportedFindings(out, brief)[0]?.reason).toBe("unverifiable_number");
    expect(dropUnsupportedFindings(out, brief).findings).toHaveLength(0);
  });

  it("mantém se ≥1 métrica confere (leniente) e ignora rótulos textuais", () => {
    const out = output([
      { id: "f1", title: "misto", detail: "x", severity: "info", metricRefs: [{ label: "inventado", value: 777 }, { label: "spend", value: 300 }], caveat: null },
      { id: "f2", title: "textual", detail: "criativo sem CTA", severity: "info", metricRefs: [{ label: "obs", value: "sem CTA" }], caveat: null },
    ]);
    expect(dropUnsupportedFindings(out, brief).findings.map((f) => f.id)).toEqual(["f1", "f2"]);
  });

  it("taxa pequena: descarta número alucinado que só 'confere' pelo inteiro (0.42 vs 0.4)", () => {
    const briefWithRate = {
      ...brief,
      funnel: { counts: { conversation_started: 100, first_reply: 40 }, replyRate: 0.4 },
    } as unknown as AccountBrief;
    // brief tem replyRate 0.4; a alucinação 0.42 não bate em 2dp e o fallback p/ inteiro
    // (Math.round=0) NÃO vale abaixo de 1 → descartada.
    const out = output([{ id: "f1", title: "resposta", detail: "taxa 0.42", severity: "info", metricRefs: [{ label: "replyRate", value: 0.42 }], caveat: null }]);
    expect(dropUnsupportedFindings(out, briefWithRate).findings).toHaveLength(0);
    // a taxa real (0.4) continua sustentando o finding.
    const ok = output([{ id: "f1", title: "resposta", detail: "taxa 0.4", severity: "info", metricRefs: [{ label: "replyRate", value: 0.4 }], caveat: null }]);
    expect(dropUnsupportedFindings(ok, briefWithRate).findings).toHaveLength(1);
  });

  it("número citado de um ponto de tendência é verificável (trends entram no gabarito)", () => {
    const briefWithTrend = {
      ...brief,
      trends: [{ date: "2026-08-15", metrics: { spend: 123, impressions: 5000, clicks: 90 } }],
    } as unknown as AccountBrief;
    const out = output([{ id: "f1", title: "pico", detail: "gasto 123 no dia", severity: "info", metricRefs: [{ label: "spend", value: 123 }], caveat: null }]);
    expect(dropUnsupportedFindings(out, briefWithTrend).findings).toHaveLength(1);
  });

  it("G4: caveat=true sustenta finding qualitativo SEM metricRefs (carve-out — não é dropado)", () => {
    const out = output([{ id: "f1", title: "compliance", detail: "linguagem sensível no criativo", severity: "warning", metricRefs: [], caveat: true }]);
    expect(flagUnsupportedFindings(out, brief)).toHaveLength(0);
    expect(dropUnsupportedFindings(out, brief).findings).toHaveLength(1);
  });

  it("G4: caveat=true NÃO afrouxa a verificação quando HÁ metricRefs (número alucinado ainda descarta)", () => {
    const out = output([{ id: "f1", title: "compliance", detail: "CPA 999", severity: "warning", metricRefs: [{ label: "CPA", value: 999 }], caveat: true }]);
    expect(flagUnsupportedFindings(out, brief)[0]?.reason).toBe("unverifiable_number");
    expect(dropUnsupportedFindings(out, brief).findings).toHaveLength(0);
  });
});
