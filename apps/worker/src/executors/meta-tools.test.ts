import { describe, expect, it, vi } from "vitest";
import type { Action } from "@trafego/shared/types";
import type { MutationResult } from "@trafego/shared/ports";
import type { WorkerDeps } from "../composition.js";
import { makeMetaToolExecutor, type ExecuteActionInput } from "./meta-tools.js";

const action: Action = {
  id: "a1",
  type: "pause_entity",
  target: { level: "campaign", id: "C1" },
  params: {},
  source: "playbook",
  riskLevel: "low",
  reason: "test",
};

const mutation: MutationResult = { action, before: { status: "ACTIVE" }, after: { status: "PAUSED" } };

/** Fake db mínimo: select→limit resolve `existing`; inserts são registrados. */
function fakeDb(existing: unknown[] = []) {
  const inserts: Array<{ table: unknown; values: unknown }> = [];
  const selectChain = {
    from: () => selectChain,
    innerJoin: () => selectChain,
    where: () => selectChain,
    limit: () => Promise.resolve(existing),
  };
  const db = {
    select: () => selectChain,
    insert: (table: unknown) => ({
      values: (values: unknown) => ({
        onConflictDoNothing: () => {
          inserts.push({ table, values });
          return Promise.resolve();
        },
        then: (onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) => {
          inserts.push({ table, values });
          return Promise.resolve().then(onF, onR);
        },
      }),
    }),
  };
  return { db, inserts };
}

function makeDeps(
  existing: unknown[] = [],
  current: Record<string, unknown> = { status: "PAUSED" },
  targetingCurrent: Record<string, unknown> | null = null,
) {
  const { db, inserts } = fakeDb(existing);
  const mutate = vi.fn(async () => mutation);
  const restoreEntityState = vi.fn(async () => ({ before: { status: "PAUSED" }, after: { status: "ACTIVE" } }));
  // estado FRESCO p/ o re-check de drift (default = igual ao `after` → sem drift).
  const readEntityState = vi.fn(async () => current);
  // targeting cru FRESCO p/ o drift fino de adjust_audience (D4); default null (não usado exceto nos testes de público).
  const readAdSetTargeting = vi.fn(async () => targetingCurrent);
  const record = vi.fn(async () => {});
  const deps = {
    db,
    logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn() },
    ports: { ads: { mutate, restoreEntityState, readEntityState, readAdSetTargeting }, metering: { record } },
  } as unknown as WorkerDeps;
  return { deps, inserts, mutate, restoreEntityState, readEntityState, readAdSetTargeting, record };
}

const baseInput: ExecuteActionInput = {
  agentId: "agent1",
  runId: "run1",
  orgId: "org1",
  account: { adAccountId: "act_1", accessToken: "tok" },
  action,
  idempotencyKey: "run1:a1",
  dryRun: false,
};

describe("makeMetaToolExecutor.execute", () => {
  it("aplica: chama mutate + grava tool_call/audit + registra usage", async () => {
    const { deps, inserts, mutate, record } = makeDeps();
    const res = await makeMetaToolExecutor(deps).execute(baseInput);
    expect(res.replayed).toBe(false);
    expect(mutate).toHaveBeenCalledWith(baseInput.account, action, { dryRun: false });
    expect(inserts).toHaveLength(2); // agent_tool_calls + audit_log
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ type: "action_applied", runId: "run1" }));
  });

  it("dry_run: simula (mutate com dryRun) e NÃO fatura (sem metering)", async () => {
    const { deps, mutate, record } = makeDeps();
    await makeMetaToolExecutor(deps).execute({ ...baseInput, dryRun: true });
    expect(mutate).toHaveBeenCalledWith(baseInput.account, action, { dryRun: true });
    expect(record).not.toHaveBeenCalled(); // dry-run não é ação faturável
  });

  it("idempotente: já registrado → replay, sem re-mutar", async () => {
    const stored = { ...mutation, dryRun: false };
    const { deps, mutate } = makeDeps([{ result: stored }]);
    const res = await makeMetaToolExecutor(deps).execute(baseInput);
    expect(res.replayed).toBe(true);
    expect(mutate).not.toHaveBeenCalled();
  });
});

const toolCall = {
  id: "tc1",
  agentId: "agent1",
  runId: "run1",
  toolKey: "pause_entity",
  beforeState: { status: "ACTIVE" } as Record<string, unknown>,
  args: { target: { level: "campaign", id: "C1" }, dryRun: false } as Record<string, unknown>,
  // a ação pausou (after=PAUSED) — base do re-check de drift.
  result: { before: { status: "ACTIVE" }, after: { status: "PAUSED" } } as Record<string, unknown>,
};
const revertInput = { orgId: "org1", account: baseInput.account, toolCall };

describe("makeMetaToolExecutor.revert", () => {
  it("reaplica o before_state + grava undo/audit", async () => {
    const { deps, inserts, restoreEntityState } = makeDeps();
    const res = await makeMetaToolExecutor(deps).revert(revertInput);
    expect(res.reverted).toBe(true);
    expect(restoreEntityState).toHaveBeenCalledWith(baseInput.account, "C1", { status: "ACTIVE" });
    expect(inserts).toHaveLength(2); // undo tool_call + audit_log
  });

  it("ação simulada → não reverte", async () => {
    const { deps, restoreEntityState } = makeDeps();
    const res = await makeMetaToolExecutor(deps).revert({
      ...revertInput,
      toolCall: { ...toolCall, args: { target: { level: "campaign", id: "C1" }, dryRun: true } },
    });
    expect(res.reverted).toBe(false);
    expect(restoreEntityState).not.toHaveBeenCalled();
  });

  it("já revertido → idempotente (não re-reverte)", async () => {
    const { deps, restoreEntityState } = makeDeps([{ id: "existing-undo" }]);
    const res = await makeMetaToolExecutor(deps).revert(revertInput);
    expect(res.reverted).toBe(true);
    expect(restoreEntityState).not.toHaveBeenCalled();
  });

  it("drift (estado mudou desde a ação) → barra e não reverte", async () => {
    // fresco = ACTIVE, mas a ação deixou PAUSED → alguém retomou depois → drift.
    const { deps, restoreEntityState } = makeDeps([], { status: "ACTIVE" });
    const res = await makeMetaToolExecutor(deps).revert(revertInput);
    expect(res.reverted).toBe(false);
    expect(res.blockedByDrift).toBe(true);
    expect(restoreEntityState).not.toHaveBeenCalled();
  });

  it("drift + force → reverte mesmo assim", async () => {
    const { deps, restoreEntityState } = makeDeps([], { status: "ACTIVE" });
    const res = await makeMetaToolExecutor(deps).revert({ ...revertInput, force: true });
    expect(res.reverted).toBe(true);
    expect(restoreEntityState).toHaveBeenCalled();
  });

  // ── D4: drift FINO de público no revert de adjust_audience ──
  const audienceToolCall = {
    ...toolCall,
    toolKey: "adjust_audience",
    args: { target: { level: "adset", id: "AS1" }, dryRun: false } as Record<string, unknown>,
    // a ação deixou o público em BR (after.targeting).
    result: { before: { targeting: { geo_locations: { countries: ["US"] } } }, after: { targeting: { geo_locations: { countries: ["BR"] } } } } as Record<string, unknown>,
    beforeState: { targeting: { geo_locations: { countries: ["US"] } } } as Record<string, unknown>,
  };
  const audienceRevert = { orgId: "org1", account: baseInput.account, toolCall: audienceToolCall };

  it("adjust_audience: público FRESCO == o que a ação deixou → reverte (sem drift)", async () => {
    // targeting atual = BR (igual ao after) → ninguém mexeu → revert fiel do público anterior.
    const { deps, restoreEntityState, readEntityState } = makeDeps([], { status: "ACTIVE" }, { geo_locations: { countries: ["BR"] } });
    const res = await makeMetaToolExecutor(deps).revert(audienceRevert);
    expect(res.reverted).toBe(true);
    expect(restoreEntityState).toHaveBeenCalledWith(baseInput.account, "AS1", { targeting: { geo_locations: { countries: ["US"] } } });
    // NÃO usou o re-check coarse de budget/status (usou o fino de targeting).
    expect(readEntityState).not.toHaveBeenCalled();
  });

  it("adjust_audience: público FRESCO mudou (alguém editou) → barra por drift", async () => {
    // após a ação (BR) alguém trocou pra US → reverter sobrescreveria essa edição → barra.
    const { deps, restoreEntityState } = makeDeps([], { status: "ACTIVE" }, { geo_locations: { countries: ["US"] } });
    const res = await makeMetaToolExecutor(deps).revert(audienceRevert);
    expect(res.reverted).toBe(false);
    expect(res.blockedByDrift).toBe(true);
    expect(restoreEntityState).not.toHaveBeenCalled();
  });

  it("adjust_audience: mesma audiência em ORDEM diferente → NÃO é drift (canonical)", async () => {
    const toolCallMulti = {
      ...audienceToolCall,
      result: { before: {}, after: { targeting: { geo_locations: { countries: ["BR", "US"] } } } } as Record<string, unknown>,
    };
    // atual = ["US","BR"] (reordenado pela Meta) → canonical igual → sem drift → reverte.
    const { deps, restoreEntityState } = makeDeps([], { status: "ACTIVE" }, { geo_locations: { countries: ["US", "BR"] } });
    const res = await makeMetaToolExecutor(deps).revert({ ...audienceRevert, toolCall: toolCallMulti });
    expect(res.reverted).toBe(true);
    expect(restoreEntityState).toHaveBeenCalled();
  });

  it("adjust_audience + force → reverte mesmo com público mudado", async () => {
    const { deps, restoreEntityState } = makeDeps([], { status: "ACTIVE" }, { geo_locations: { countries: ["US"] } });
    const res = await makeMetaToolExecutor(deps).revert({ ...audienceRevert, force: true });
    expect(res.reverted).toBe(true);
    expect(restoreEntityState).toHaveBeenCalled();
  });
});

describe("revertCreation (Slice 11 — teardown de criação/escala)", () => {
  function makeCreationDeps(existing: unknown[] = []) {
    const updates: Array<{ values: unknown }> = [];
    const selectChain = {
      from: () => selectChain,
      where: () => selectChain,
      limit: () => Promise.resolve(existing),
    };
    const db = {
      select: () => selectChain,
      insert: () => ({
        values: () => ({
          onConflictDoNothing: () => Promise.resolve(),
          then: (onF: (v: unknown) => unknown) => Promise.resolve().then(onF),
        }),
      }),
      update: () => ({ set: (values: unknown) => ({ where: () => { updates.push({ values }); return Promise.resolve(); } }) }),
    };
    const mutate = vi.fn(async (_account: unknown, _action: Action) => mutation);
    const record = vi.fn(async () => {});
    const deps = {
      db,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      ports: { ads: { mutate }, metering: { record } },
    } as unknown as WorkerDeps;
    return { deps, updates, mutate };
  }

  const account = { adAccountId: "act1", accessToken: "t" };
  const creationTc = {
    id: "tc1",
    agentId: "ag1",
    runId: null,
    beforeState: null,
    args: { draftId: "d1", kind: "from_scratch", target: { level: "campaign", id: "C9" } },
    result: { createdIds: { campaignId: "C9" } },
  } as never;

  it("pausa a RAIZ (set_status PAUSED) + marca o rascunho revertido", async () => {
    const { deps, mutate, updates } = makeCreationDeps([]);
    const res = await makeMetaToolExecutor(deps).revertCreation({ orgId: "org1", account, toolCall: creationTc, mode: "pause" });
    expect(res.reverted).toBe(true);
    const emitted = mutate.mock.calls[0]![1];
    expect(emitted.type).toBe("set_status");
    expect(emitted.params["status"]).toBe("PAUSED");
    expect(emitted.target.id).toBe("C9");
    expect(updates.length).toBe(2); // campaign_drafts → reverted + approval de ativação → expired
    const statuses = updates.map((u) => (u.values as { status?: string }).status);
    expect(statuses).toContain("reverted"); // rascunho
    expect(statuses).toContain("expired"); // aprovação de ativação órfã cancelada
  });

  it("mode archive → set_status ARCHIVED", async () => {
    const { deps, mutate } = makeCreationDeps([]);
    await makeMetaToolExecutor(deps).revertCreation({ orgId: "org1", account, toolCall: creationTc, mode: "archive" });
    expect((mutate.mock.calls[0]![1]).params["status"]).toBe("ARCHIVED");
  });

  it("já revertido (undo existe) → reverted:true sem re-mutar", async () => {
    const { deps, mutate } = makeCreationDeps([{ id: "undo1" }]);
    const res = await makeMetaToolExecutor(deps).revertCreation({ orgId: "org1", account, toolCall: creationTc });
    expect(res.reverted).toBe(true);
    expect(mutate).not.toHaveBeenCalled();
  });

  it("ESCALA: já pausado + pedido de arquivar → aplica ARCHIVED (não devolve sucesso vazio)", async () => {
    const { deps, mutate, updates } = makeCreationDeps([{ id: "undo1", args: { mode: "pause" } }]);
    const res = await makeMetaToolExecutor(deps).revertCreation({ orgId: "org1", account, toolCall: creationTc, mode: "archive" });
    expect(res.reverted).toBe(true);
    expect((mutate.mock.calls[0]![1]).params["status"]).toBe("ARCHIVED"); // aplicou de verdade
    expect(updates.length).toBe(3); // undo tool_call + campaign_drafts + approval de ativação
  });

  it("NÃO desarquiva: já arquivado + pedido de pausar → no-op honesto, sem re-mutar", async () => {
    const { deps, mutate } = makeCreationDeps([{ id: "undo1", args: { mode: "archive" } }]);
    const res = await makeMetaToolExecutor(deps).revertCreation({ orgId: "org1", account, toolCall: creationTc, mode: "pause" });
    expect(res.reverted).toBe(true);
    expect(res.reason).toContain("arquivada");
    expect(mutate).not.toHaveBeenCalled();
  });

  it("dry-run → nada a reverter", async () => {
    const { deps, mutate } = makeCreationDeps([]);
    const dryTc = { ...(creationTc as object), args: { draftId: "d1", dryRun: true } } as never;
    const res = await makeMetaToolExecutor(deps).revertCreation({ orgId: "org1", account, toolCall: dryTc });
    expect(res.reverted).toBe(false);
    expect(mutate).not.toHaveBeenCalled();
  });
});
