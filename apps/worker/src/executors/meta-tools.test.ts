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

function makeDeps(existing: unknown[] = []) {
  const { db, inserts } = fakeDb(existing);
  const mutate = vi.fn(async () => mutation);
  const record = vi.fn(async () => {});
  const deps = {
    db,
    logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn() },
    ports: { ads: { mutate }, metering: { record } },
  } as unknown as WorkerDeps;
  return { deps, inserts, mutate, record };
}

const baseInput: ExecuteActionInput = {
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

  it("dry_run: propaga o flag pro mutate e pro metering", async () => {
    const { deps, mutate, record } = makeDeps();
    await makeMetaToolExecutor(deps).execute({ ...baseInput, dryRun: true });
    expect(mutate).toHaveBeenCalledWith(baseInput.account, action, { dryRun: true });
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ payload: expect.objectContaining({ dryRun: true }) }));
  });

  it("idempotente: já registrado → replay, sem re-mutar", async () => {
    const stored = { ...mutation, dryRun: false };
    const { deps, mutate } = makeDeps([{ result: stored }]);
    const res = await makeMetaToolExecutor(deps).execute(baseInput);
    expect(res.replayed).toBe(true);
    expect(mutate).not.toHaveBeenCalled();
  });
});
