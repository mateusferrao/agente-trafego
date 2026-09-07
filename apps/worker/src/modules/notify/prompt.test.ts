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

describe("buildMessageMessages (redator) — Fatia B: agrupa TODAS + oferta do aprovável", () => {
  it("agrupa em posso_fazer (com ressalva) / sua_direcao / observei e a regra de voz oferece 'pode'", () => {
    const out = output({
      recommendations: [
        { id: "d1", title: "Corrigir público", rationale: "45-65+", priority: "high", actionType: "review_audience", targetEntity: null, budgetChangePct: null, expectedImpact: null, whatToMonitor: null, findingRefs: null },
        { id: "o1", title: "NUCLEO em aprendizado", rationale: "aguarde", priority: "low", actionType: "keep", targetEntity: null, budgetChangePct: null, expectedImpact: null, whatToMonitor: null, findingRefs: null },
      ],
    });
    const messages = buildMessageMessages("persona", "Loja X", out, DEFAULT_POSTURE, {
      approvable: [{ reason: "escalar o vencedor Y: +20%", ressalvas: ["criativo cansando"] }],
    });
    const user = userOf(messages);
    expect(user).toContain("posso_fazer");
    expect(user).toContain("escalar o vencedor Y: +20%");
    expect(user).toContain("criativo cansando");
    expect(user).toContain("sua_direcao");
    expect(user).toContain("Corrigir público");
    expect(user).toContain("observei");
    expect(user).toContain("NUCLEO em aprendizado");
    const system = (messages[0]!.content as string).toLowerCase();
    expect(system).toContain("posso_fazer");
    expect(system).toContain("pode");
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
