import { describe, expect, it } from "vitest";
import { DEFAULT_POSTURE } from "@trafego/shared";
import type { AnalysisOutput } from "@trafego/shared/schemas";
import { buildMessageMessages } from "./prompt.js";

function output(overrides: Partial<AnalysisOutput> = {}): AnalysisOutput {
  return {
    scorecard: { grade: "B", headline: "ok", biggestLeak: "conversao" },
    summary: "Conta gastou R$300 nesta semana.",
    findings: [],
    recommendations: [],
    ...overrides,
  };
}

function userOf(messages: ReturnType<typeof buildMessageMessages>): string {
  return messages[1]!.content as string;
}

describe("buildMessageMessages (redator) — S1: lidera por orçamento sem folga", () => {
  it("sem campanhas no teto: não injeta atBudgetCeilingCampaigns no curado", () => {
    const user = userOf(buildMessageMessages("persona", "Clínica X", output(), DEFAULT_POSTURE, {}));
    expect(user).not.toContain("atBudgetCeilingCampaigns");
  });

  it("com campanhas no teto: injeta os nomes no curado + a regra de voz menciona liderar por isso", () => {
    const messages = buildMessageMessages("persona", "Clínica X", output(), DEFAULT_POSTURE, {
      atBudgetCeilingCampaigns: ["Lançamento Black Friday"],
    });
    const user = userOf(messages);
    expect(user).toContain("atBudgetCeilingCampaigns");
    expect(user).toContain("Lançamento Black Friday");
    const system = messages[0]!.content as string;
    expect(system.toLowerCase()).toContain("atbudgetceilingcampaigns");
  });
});

describe("buildMessageMessages (redator) — comportamento existente (waste/tracking), agora com teste", () => {
  it("sem waste real: não injeta o bloco de desperdício no curado", () => {
    const user = userOf(buildMessageMessages("persona", "Clínica X", output(), DEFAULT_POSTURE, {}));
    expect(user).not.toContain("wastedSpend");
  });

  it("com waste real: injeta wastedSpend/misallocated no curado", () => {
    const user = userOf(
      buildMessageMessages("persona", "Clínica X", output(), DEFAULT_POSTURE, {
        waste: { totalSpend: 100, wastedSpend: 40, wastedPct: 40, zombies: [{ id: "z", name: "Zumbi", spend: 40 }] },
      }),
    );
    expect(user).toContain("wastedSpend");
  });

  it("trackingSuspect: injeta trackingSuspect:true no curado", () => {
    const user = userOf(buildMessageMessages("persona", "Clínica X", output(), DEFAULT_POSTURE, { trackingSuspect: true }));
    expect(user).toContain("trackingSuspect");
  });
});

describe("buildMessageMessages (redator) — S8: lidera por qualidade do lead (vertical=health) antes de métrica de vaidade", () => {
  const COLD_FUNNEL = { counts: { conversation_started: 30 }, replyRate: 0.2 };
  const HEALTHY_FUNNEL = { counts: { conversation_started: 30 }, replyRate: 0.7 };

  it("vertical=health + funil frio (replyRate baixa, volume suficiente) → injeta leadQualityCaveat + regra de ordenação", () => {
    const messages = buildMessageMessages("persona", "Clínica X", output(), DEFAULT_POSTURE, { funnel: COLD_FUNNEL }, "health");
    expect(userOf(messages)).toContain("leadQualityCaveat");
    const system = messages[0]!.content as string;
    expect(system).toMatch(/leadQualityCaveat/);
    expect(system).toMatch(/antes/i); // ordenação: caveat ANTES do CPL/CPA bom
  });

  it("vertical=health + funil saudável (replyRate boa) → NÃO injeta leadQualityCaveat", () => {
    const user = userOf(buildMessageMessages("persona", "Clínica X", output(), DEFAULT_POSTURE, { funnel: HEALTHY_FUNNEL }, "health"));
    expect(user).not.toContain("leadQualityCaveat");
  });

  it("funil frio mas vertical != health → NÃO injeta (regra é escopada à saúde pelo plano)", () => {
    const user = userOf(buildMessageMessages("persona", "Clínica X", output(), DEFAULT_POSTURE, { funnel: COLD_FUNNEL }, "generico"));
    expect(user).not.toContain("leadQualityCaveat");
  });

  it("sem vertical informado → NÃO injeta (default seguro, não assume saúde)", () => {
    const user = userOf(buildMessageMessages("persona", "Clínica X", output(), DEFAULT_POSTURE, { funnel: COLD_FUNNEL }));
    expect(user).not.toContain("leadQualityCaveat");
  });
});
