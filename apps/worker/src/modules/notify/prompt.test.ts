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
