import { describe, expect, it } from "vitest";
import type { EntitySummary } from "@trafego/shared";
import { buildAccountBrief } from "./index.js";
import { STETICOS_ACCOUNT, STETICOS_BASELINE, STETICOS_ENTITIES, STETICOS_ROWS } from "./__fixtures__/steticos.js";

function run(goals: Parameters<typeof buildAccountBrief>[0]["goals"]) {
  const res = buildAccountBrief({
    account: STETICOS_ACCOUNT,
    window: "últimos 7 dias",
    baselineWindow: "7 dias anteriores",
    goals,
    entities: STETICOS_ENTITIES,
    rows: STETICOS_ROWS,
    baselineRows: STETICOS_BASELINE,
    playbookCandidates: [],
    topN: 10,
    notableAdsPerCampaign: 3,
    // pivô: as faixas de custo vêm da referência configurável (resolvida na moeda
    // da conta) — aqui injetadas direto p/ exercitar o caminho de cold-start.
    costTable: { conversation: { min: 3, max: 15 } },
  });
  if (res.status !== "ok") throw new Error("brief vazio inesperado");
  const byId = new Map(res.brief.segments.campaigns.map((c) => [c.id, c]));
  return byId;
}

describe("qualidade end-to-end na fixture Steticos", () => {
  const goals = { conversionGoal: "messaging_started" as const, targetCPA: 7 };

  it("classifica os tiers coerentemente", () => {
    const c = run(goals);
    expect(c.get("C_ESCALA")!.tier).toBe("winner"); // cpa 5 < meta 7
    expect(c.get("C_ZUMBI")!.tier).toBe("zombie"); // gastou 300, 0 conversa
    expect(c.get("C_FADIGA")!.tier).toBe("underperformer"); // cpa subiu, acima da meta
    expect(c.get("C_NOVA")!.tier).toBeUndefined(); // sem baseline → não julga
  });

  it("detecta fadiga na campanha cansada (CTR↓ + freq>3 + custo↑)", () => {
    const fadiga = run(goals).get("C_FADIGA")!;
    expect(fadiga.healthSignals).toContain("creative_fatigue");
    expect(fadiga.healthSignals).toContain("audience_saturation");
  });

  it("marca learning/baixo volume na campanha nova (sem baseline)", () => {
    const nova = run(goals).get("C_NOVA")!;
    expect(nova.eligibility?.inLearning).toBe(true);
    expect(nova.eligibility?.hasSignificance).toBe(false);
    expect(nova.healthSignals).toContain("low_volume");
  });

  it("sem meta e sem histórico → referência de cold-start rotulada", () => {
    // conta 'nova' inteira: sem meta e a campanha nova não tem baseline.
    const nova = run({ conversionGoal: "messaging_started" }).get("C_NOVA")!;
    expect(nova.benchmarkRef?.coldStart).toBe(true);
    expect(nova.benchmarkRef?.costReference?.label).toBe("custo por conversa");
    // com meta definida, NÃO entra referência (a meta manda).
    const comMeta = run(goals).get("C_NOVA") as EntitySummary;
    expect(comMeta.benchmarkRef).toBeUndefined();
  });
});
