import { describe, expect, it, vi } from "vitest";
import type { Database } from "@trafego/db";
import { INSIGHTS_SYNC_JOB, SYNC_QUEUE } from "@trafego/shared";
import type { EncryptedPayload } from "@trafego/shared/types";
import { createAdminService } from "./service.js";

const SENTINEL: EncryptedPayload = { ciphertext: "ct", iv: "iv", tag: "tg", keyVersion: 1 };

/** DB falso: `.limit()` devolve os resultados de select em ordem; captura o insert. */
function makeFakeDb(selectResults: unknown[][], insertReturning: unknown[] = [{ id: "acct-1" }]) {
  const captured: { insertValues?: Record<string, unknown> } = {};
  const db = {
    select: () => ({
      from: () => ({ where: () => ({ limit: async () => selectResults.shift() ?? [] }) }),
    }),
    insert: () => ({
      values: (v: Record<string, unknown>) => {
        captured.insertValues = v;
        const chain = { returning: async () => insertReturning };
        // suporta tanto .values().returning() quanto .values().onConflictDoUpdate().returning()
        return { ...chain, onConflictDoUpdate: () => chain };
      },
    }),
  };
  return { db: db as unknown as Database, captured };
}

function makeVault() {
  return { encrypt: vi.fn(() => SENTINEL), decrypt: vi.fn() };
}
function makeScheduler() {
  return { enqueue: vi.fn(async () => undefined), upsertSchedule: vi.fn(), removeSchedule: vi.fn() };
}

const INPUT = { metaBusinessId: "biz1", adAccountId: "123", token: "SYSTEM-TOKEN" };

describe("createAdminService.connectAccount", () => {
  it("cifra o token e persiste sob a org beta", async () => {
    const { db, captured } = makeFakeDb([[{ id: "org-1" }]]);
    const vault = makeVault();
    const service = createAdminService({ db, vault, scheduler: makeScheduler() });

    const result = await service.connectAccount(INPUT);

    expect(vault.encrypt).toHaveBeenCalledWith("SYSTEM-TOKEN");
    expect(captured.insertValues).toMatchObject({
      orgId: "org-1",
      metaBusinessId: "biz1",
      adAccountId: "123",
      tokenCripto: SENTINEL,
    });
    expect(result).toEqual({ id: "acct-1" });
  });

  it("falha claro quando a org beta não existe (seed não rodado)", async () => {
    const { db } = makeFakeDb([[]]);
    const service = createAdminService({ db, vault: makeVault(), scheduler: makeScheduler() });
    await expect(service.connectAccount(INPUT)).rejects.toMatchObject({ statusCode: 400 });
  });
});

describe("createAdminService.triggerSync", () => {
  it("enfileira insights-sync com o payload da conta", async () => {
    const { db } = makeFakeDb([[{ id: "org-1" }], [{ id: "acct-1" }]]);
    const scheduler = makeScheduler();
    const service = createAdminService({ db, vault: makeVault(), scheduler });

    await service.triggerSync("acct-1");

    expect(scheduler.enqueue).toHaveBeenCalledWith({
      queue: SYNC_QUEUE,
      name: INSIGHTS_SYNC_JOB,
      payload: { accountId: "acct-1", orgId: "org-1", trigger: "manual" },
    });
  });
});
