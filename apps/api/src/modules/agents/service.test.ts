import { describe, expect, it, vi } from "vitest";
import type { Database } from "@trafego/db";
import type { OrgId } from "@trafego/shared/types";
import { createAgentsService } from "./service.js";

/**
 * DB falso: cada `where()` consome UM resultado de `selectResults` (em ordem) e é
 * tanto awaitable (queries sem `.limit`) quanto `.limit()`-able. Captura insert/
 * update/delete p/ asserção.
 */
function makeFakeDb(selectResults: unknown[][], insertReturning: unknown[] = [{ id: "agent-new" }]) {
  const captured: {
    insertValues?: Record<string, unknown>;
    updateSet?: Record<string, unknown>;
    deleted?: boolean;
    conflictDoNothing?: boolean;
  } = {};
  const whereResult = () => {
    const rows = selectResults.shift() ?? [];
    return {
      limit: async () => rows,
      then: (resolve: (v: unknown) => void) => resolve(rows),
    };
  };
  const db = {
    select: () => ({ from: () => ({ where: () => whereResult() }) }),
    insert: () => ({
      values: (v: Record<string, unknown>) => {
        captured.insertValues = v;
        return {
          returning: async () => insertReturning,
          onConflictDoNothing: async () => {
            captured.conflictDoNothing = true;
          },
        };
      },
    }),
    update: () => ({
      set: (v: Record<string, unknown>) => {
        captured.updateSet = v;
        return { where: async () => undefined };
      },
    }),
    delete: () => ({
      where: async () => {
        captured.deleted = true;
      },
    }),
  };
  return { db: db as unknown as Database, captured };
}

const ORG = "org-1" as OrgId;

describe("agents.getOrCreateForAccount", () => {
  it("cria o agente default (arquétipo conservador) quando não existe", async () => {
    const { db, captured } = makeFakeDb([[{ id: "acc-1" }], []], [{ id: "agent-new" }]);
    const service = createAgentsService({ db });

    const result = await service.getOrCreateForAccount(ORG, "acc-1");

    expect(result.agentId).toBe("agent-new");
    expect(result.archetype).toBe("conservador");
    expect(captured.insertValues?.archetype).toBe("conservador");
    expect(captured.insertValues?.autonomyPolicy).toBeDefined();
  });

  it("retorna o agente existente sem criar outro", async () => {
    const { db, captured } = makeFakeDb([[{ id: "acc-1" }], [{ id: "ag-1", archetype: "conservador", goals: { targetCPA: 40 } }]]);
    const service = createAgentsService({ db });

    const result = await service.getOrCreateForAccount(ORG, "acc-1");

    expect(result.agentId).toBe("ag-1");
    expect(result.goals).toEqual({ targetCPA: 40 });
    expect(captured.insertValues).toBeUndefined();
  });

  it("404 quando a conta não é da org", async () => {
    const { db } = makeFakeDb([[]]);
    const service = createAgentsService({ db });
    await expect(service.getOrCreateForAccount(ORG, "nope")).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe("agents.updateConfig", () => {
  it("salva meta+conversão+textos+janela, apara/limpa e bumpa configChangedAt (força deep)", async () => {
    // selects em ordem: conta, agente (getOrCreate), model_config (merge da janela).
    const { db, captured } = makeFakeDb([
      [{ id: "acc-1" }],
      [{ id: "ag-1", archetype: "conservador", goals: {} }],
      [{ modelConfig: { model: "x" } }],
    ]);
    const service = createAgentsService({ db });

    const result = await service.updateConfig(ORG, "acc-1", {
      goals: { targetCPA: 150, conversionGoal: "purchase" },
      businessContext: "  Lançamento até 30/08  ",
      guidance: "",
      analysisWindowDays: 30,
    });

    expect(result.goals).toEqual({ targetCPA: 150, conversionGoal: "purchase" });
    expect(result.businessContext).toBe("Lançamento até 30/08"); // aparado
    expect(result.guidance).toBeNull(); // "" → null
    expect(result.analysisWindowDays).toBe(30);
    expect(captured.updateSet?.goals).toEqual({ targetCPA: 150, conversionGoal: "purchase" });
    expect(captured.updateSet?.businessContext).toBe("Lançamento até 30/08");
    expect(captured.updateSet?.guidance).toBeNull();
    // merge no model_config preserva as outras chaves e grava a janela.
    expect(captured.updateSet?.modelConfig).toEqual({ model: "x", windowDays: 30 });
    expect(captured.updateSet?.configChangedAt).toBeDefined(); // marca p/ o deep no próximo run
  });
});

describe("agents.availableConversions", () => {
  it("agrega conversões da janela (nível conta) + junta o rótulo real, ordenado por contagem", async () => {
    const snapshots = [
      { metricsJson: { metrics: {}, conversions: [{ goal: "purchase", count: 5 }, { goal: "custom", customConversionId: "123", count: 2 }] } },
      { metricsJson: { metrics: {}, conversions: [{ goal: "purchase", count: 3 }] } },
    ];
    const labels = [{ goal: "custom", customConversionId: "123", label: "Comprou Curso" }];
    const { db } = makeFakeDb([snapshots, labels]);
    const service = createAgentsService({ db });

    const result = await service.availableConversions(ORG, "acc-1");

    expect(result.conversions).toEqual([
      { goal: "purchase", count: 8 },
      { goal: "custom", customConversionId: "123", count: 2, label: "Comprou Curso" },
    ]);
  });
});

describe("agents.muteCampaign / unmuteCampaign", () => {
  it("silencia campanha: insere (level campaign, org+agente escopados) idempotente e devolve a lista", async () => {
    // selects em ordem: conta, agente (getOrCreate) + lista de silenciadas.
    const { db, captured } = makeFakeDb([
      [{ id: "acc-1" }],
      [{ id: "ag-1", archetype: "conservador", goals: {} }],
      [{ externalId: "C1" }],
    ]);
    const service = createAgentsService({ db });

    const result = await service.muteCampaign(ORG, "acc-1", "C1");

    expect(result).toEqual(["C1"]);
    expect(captured.insertValues).toMatchObject({
      orgId: ORG,
      agentId: "ag-1",
      entityLevel: "campaign",
      externalId: "C1",
    });
    expect(captured.conflictDoNothing).toBe(true);
  });

  it("reativa campanha: deleta a linha e devolve a lista atualizada (vazia)", async () => {
    const { db, captured } = makeFakeDb([
      [{ id: "acc-1" }],
      [{ id: "ag-1", archetype: "conservador", goals: {} }],
      [],
    ]);
    const service = createAgentsService({ db });

    const result = await service.unmuteCampaign(ORG, "acc-1", "C1");

    expect(result).toEqual([]);
    expect(captured.deleted).toBe(true);
  });
});
