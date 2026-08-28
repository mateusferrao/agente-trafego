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

function makeDeps(existing: unknown[] = [], current: Record<string, unknown> = { status: "PAUSED" }) {
  const { db, inserts } = fakeDb(existing);
  const mutate = vi.fn(async () => mutation);
  const restoreEntityState = vi.fn(async () => ({ before: { status: "PAUSED" }, after: { status: "ACTIVE" } }));
  // estado FRESCO p/ o re-check de drift (default = igual ao `after` → sem drift).
  const readEntityState = vi.fn(async () => current);
  const record = vi.fn(async () => {});
  const deps = {
    db,
    logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn() },
    ports: { ads: { mutate, restoreEntityState, readEntityState }, metering: { record } },
  } as unknown as WorkerDeps;
  return { deps, inserts, mutate, restoreEntityState, readEntityState, record };
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
    expect(updates.length).toBe(1); // campaign_drafts → reverted
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
    expect(updates.length).toBe(2); // atualiza o undo tool_call + campaign_drafts
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
