import { describe, expect, it } from "vitest";
import { ANALYSIS_OUTPUT_JSON_SCHEMA, analysisOutputSchema } from "./index.js";

const valid = {
  scorecard: { grade: "B", headline: "Boa entrega, conversão abaixo do potencial.", biggestLeak: "conversao" },
  summary: "Conta gastou R$300 nos últimos 7 dias.",
  findings: [
    { id: "f1", title: "CPA alto", detail: "Campanha B a R$100/venda", severity: "warning", metricRefs: [{ label: "CPA", value: 100 }] },
  ],
  recommendations: [
    { id: "r1", title: "Pausar B", rationale: "CPA 2x a meta", priority: "high", actionType: "pause", targetEntity: { level: "campaign", externalId: "c2" }, budgetChangePct: null },
  ],
};

describe("analysisOutputSchema", () => {
  it("valida um output bem formado", () => {
    const parsed = analysisOutputSchema.safeParse(valid);
    expect(parsed.success).toBe(true);
  });

  it("aceita targetEntity/budgetChangePct nulos (strict json_schema)", () => {
    const parsed = analysisOutputSchema.safeParse({
      ...valid,
      recommendations: [{ ...valid.recommendations[0], actionType: "investigate", targetEntity: null, budgetChangePct: null }],
    });
    expect(parsed.success).toBe(true);
  });

  it("rejeita output sem findings/recommendations", () => {
    expect(analysisOutputSchema.safeParse({ summary: "x" }).success).toBe(false);
  });

  it("rejeita severity/actionType fora do enum", () => {
    const bad = { ...valid, findings: [{ ...valid.findings[0], severity: "fatal" }] };
    expect(analysisOutputSchema.safeParse(bad).success).toBe(false);
  });
});

describe("ANALYSIS_OUTPUT_JSON_SCHEMA", () => {
  it("é um JSON schema de objeto com as chaves do output", () => {
    expect(ANALYSIS_OUTPUT_JSON_SCHEMA.type).toBe("object");
    const props = ANALYSIS_OUTPUT_JSON_SCHEMA.properties as Record<string, unknown>;
    expect(props.summary).toBeDefined();
    expect(props.findings).toBeDefined();
    expect(props.recommendations).toBeDefined();
  });
});
