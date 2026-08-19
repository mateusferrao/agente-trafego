import { describe, expect, it, vi } from "vitest";
import type { Database } from "@trafego/db";
import type { OrgId } from "@trafego/shared/types";
import { createAgentsService } from "./service.js";

/** DB falso: selects retornam por .limit() em ordem; captura insert/update. */
function makeFakeDb(selectResults: unknown[][], insertReturning: unknown[] = [{ id: "agent-new" }]) {
  const captured: { insertValues?: Record<string, unknown>; updateSet?: Record<string, unknown> } = {};
  const db = {
    select: () => ({ from: () => ({ where: () => ({ limit: async () => selectResults.shift() ?? [] }) }) }),
    insert: () => ({
      values: (v: Record<string, unknown>) => {
        captured.insertValues = v;
        return { returning: async () => insertReturning };
      },
    }),
    update: () => ({
      set: (v: Record<string, unknown>) => {
        captured.updateSet = v;
        return { where: async () => undefined };
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

describe("agents.updateGoals", () => {
  it("grava a meta sem chaves undefined (exactOptional)", async () => {
    const { db, captured } = makeFakeDb([[{ id: "acc-1" }], [{ id: "ag-1", archetype: "conservador", goals: {} }]]);
    const service = createAgentsService({ db });

    const result = await service.updateGoals(ORG, "acc-1", { targetCPA: 50 });

    expect(result.goals).toEqual({ targetCPA: 50 });
    expect(captured.updateSet?.goals).toEqual({ targetCPA: 50 });
    expect(Object.keys(captured.updateSet?.goals as object)).not.toContain("targetROAS");
  });
});
