import { describe, expect, it, vi } from "vitest";
import type { Database } from "@trafego/db";
import type { OrgId } from "@trafego/shared";
import type { SchedulerPort } from "@trafego/shared/ports";
import { applyAgentConfigChange, reseedArchetypeChange } from "./index.js";

const ORG = "org-1" as OrgId;

const AGENT_ROW = {
  goals: { targetCPA: 40 },
  businessContext: "antigo",
  guidance: null,
  persona: null,
  tone: null,
  systemPrompt: null,
  cadence: null,
  modelConfig: { model: "x" },
  autonomyPolicy: { bySource: { playbook: "suggest", llm: "suggest" } },
  archetype: "conservador",
};

/**
 * DB falso: `where()` consome UM resultado de `selectResults` (em ordem, `.limit()`-able).
 * Captura updates e inserts (por tabela via a 1ª chave reconhecível) p/ asserção.
 */
function makeFakeDb(selectResults: unknown[][]) {
  const captured: {
    updateSet?: Record<string, unknown>;
    guardrailInsert?: Record<string, unknown>;
    auditInsert?: Record<string, unknown>;
  } = {};
  const whereResult = () => {
    const rows = selectResults.shift() ?? [];
    return { limit: async () => rows, then: (r: (v: unknown) => void) => r(rows) };
  };
  const db = {
    select: () => ({ from: () => ({ where: () => whereResult() }) }),
    update: () => ({
      set: (v: Record<string, unknown>) => {
        captured.updateSet = v;
        return { where: async () => undefined };
      },
    }),
    insert: () => ({
      values: (v: Record<string, unknown>) => {
        // audit_log carrega `action`; guardrail_configs carrega `maxBudgetChangePct`.
        if ("action" in v) captured.auditInsert = v;
        else captured.guardrailInsert = v;
        const chain = {
          onConflictDoUpdate: async () => undefined,
          then: (r: (v: unknown) => void) => r(undefined),
        };
        return chain;
      },
    }),
  };
  return { db: db as unknown as Database, captured };
}

function makeScheduler() {
  const enqueue = vi.fn(async () => undefined);
  const scheduler = { upsertSchedule: async () => {}, removeSchedule: async () => {}, enqueue } as SchedulerPort;
  return { scheduler, enqueue };
}

describe("applyAgentConfigChange", () => {
  it("mescla + persiste, bumpa configChangedAt e devolve changed/weakensSafety", async () => {
    // selects: agent row, guardrails (vazio → defaults).
    const { db, captured } = makeFakeDb([[AGENT_ROW], []]);
    const { scheduler } = makeScheduler();

    const result = await applyAgentConfigChange(
      { db, scheduler },
      {
        orgId: ORG,
        agentId: "ag-1",
        accountId: "acc-1",
        patch: { goals: { targetCPA: 99 }, businessContext: "  novo  " },
      },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.changed).toContain("meta");
    expect(result.changed).toContain("contexto");
    expect(result.weakensSafety).toBe(false);
    expect(captured.updateSet?.goals).toEqual({ targetCPA: 99 });
    expect(captured.updateSet?.businessContext).toBe("novo");
    expect(captured.updateSet?.configChangedAt).toBeDefined();
  });

  it("cadência nova → enfileira resync (uma vez)", async () => {
    const { db } = makeFakeDb([[AGENT_ROW], []]);
    const { scheduler, enqueue } = makeScheduler();

    await applyAgentConfigChange(
      { db, scheduler },
      { orgId: ORG, agentId: "ag-1", accountId: "acc-1", patch: { cadence: { kind: "daily", hour: 9 } } },
    );

    expect(enqueue).toHaveBeenCalledTimes(1);
  });

  it("guardrail afrouxado (dry-run off) → weakensSafety + upsert em guardrail_configs", async () => {
    const guardrailRow = {
      maxBudgetChangePct: 20,
      maxEntitiesPerDay: 3,
      allowedActions: ["pause_entity"],
      dryRun: true,
      killSwitch: false,
      llmCostCap: null,
    };
    const { db, captured } = makeFakeDb([[AGENT_ROW], [guardrailRow]]);
    const { scheduler } = makeScheduler();

    const result = await applyAgentConfigChange(
      { db, scheduler },
      {
        orgId: ORG,
        agentId: "ag-1",
        accountId: "acc-1",
        patch: {
          guardrails: {
            maxBudgetChangePct: 20,
            maxEntitiesPerDay: 3,
            allowedActions: ["pause_entity"],
            dryRun: false,
            killSwitch: false,
          },
        },
      },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.weakensSafety).toBe(true);
    expect(captured.guardrailInsert?.dryRun).toBe(false);
  });

  it("conversão custom sem id → ok:false, não persiste", async () => {
    const { db, captured } = makeFakeDb([[AGENT_ROW], []]);
    const { scheduler } = makeScheduler();

    const result = await applyAgentConfigChange(
      { db, scheduler },
      { orgId: ORG, agentId: "ag-1", accountId: "acc-1", patch: { goals: { conversionGoal: "custom" } } },
    );

    expect(result.ok).toBe(false);
    expect(captured.updateSet).toBeUndefined();
  });

  it("audit fornecido → grava linha em audit_log", async () => {
    const { db, captured } = makeFakeDb([[AGENT_ROW], []]);
    const { scheduler } = makeScheduler();

    await applyAgentConfigChange(
      { db, scheduler },
      {
        orgId: ORG,
        agentId: "ag-1",
        accountId: "acc-1",
        patch: { businessContext: "novo" },
        audit: { actor: { label: "user:contato", userId: "u-1" } },
      },
    );

    expect(captured.auditInsert?.action).toBe("agent.config.update");
    expect(captured.auditInsert?.target).toBe("agent:ag-1");
    expect(captured.auditInsert?.actorUserId).toBe("u-1");
  });
});

describe("reseedArchetypeChange", () => {
  it("reseta comportamento p/ o arquétipo e semeia cadência default (Guardião → 2×/dia)", async () => {
    // agente sem cadência própria → recebe a default do arquétipo.
    const { db, captured } = makeFakeDb([[{ ...AGENT_ROW, cadence: null }], []]);
    const { scheduler, enqueue } = makeScheduler();

    const result = await reseedArchetypeChange(
      { db, scheduler },
      { orgId: ORG, agentId: "ag-1", accountId: "acc-1", archetype: "guardiao_lancamento" },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.archetype).toBe("guardiao_lancamento");
    expect(result.cadence).toEqual({ kind: "twice_daily", hours: [8, 18] });
    expect(captured.updateSet?.persona).toBeNull();
    expect(captured.updateSet?.configChangedAt).toBeDefined();
    expect(enqueue).toHaveBeenCalledTimes(1); // cadência semeada mudou
  });
});
