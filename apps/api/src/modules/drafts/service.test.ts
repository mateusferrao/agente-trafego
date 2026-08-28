import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { OrgId } from "@trafego/shared/types";
import { createDraftsService } from "./service.js";

/**
 * db fake encadeável só p/ getCreativeBlob: select→from→where→limit devolve `rows`.
 * `where` captura o predicado? Não precisa — o teste injeta as rows que o org-scope
 * DEVERIA devolver (match) ou não (cross-tenant → []), provando que o service confia
 * no lookup org-scoped e nunca no ref do cliente.
 */
function fakeDb(rows: unknown[]) {
  return {
    select: () => ({ from: () => ({ where: () => ({ limit: () => rows }) }) }),
  } as never;
}

function makeService(rows: unknown[], get = vi.fn()) {
  const storage = { put: vi.fn(), get, signedUrl: vi.fn() };
  return {
    service: createDraftsService({
      db: fakeDb(rows),
      adsPlatform: {} as never,
      vault: {} as never,
      approvals: {} as never,
      storage: storage as never,
      scheduler: {} as never,
    }),
    get,
  };
}

const ORG = "org-1" as OrgId;

/** db fake p/ deleteCreative: 1º select = lookup do asset (via .limit), 2º select = count de
 *  referências (via await direto). update()/delete() são no-op capturados. Cada `where` consome
 *  o próximo resultado da fila. */
function fakeDbForDelete(assetRows: unknown[], countRows: unknown[], captured: { archived?: boolean; deleted?: boolean }) {
  const queue = [assetRows, countRows];
  const where = () => {
    const rows = queue.shift() ?? [];
    return { limit: () => rows, then: (r: (v: unknown) => void) => r(rows) };
  };
  return {
    select: () => ({ from: () => ({ where }) }),
    update: () => ({ set: () => ({ where: async () => { captured.archived = true; } }) }),
    delete: () => ({ where: async () => { captured.deleted = true; } }),
  } as never;
}

function makeDeleteService(assetRows: unknown[], countRows: unknown[]) {
  const del = vi.fn(async () => {});
  const captured: { archived?: boolean; deleted?: boolean } = {};
  const storage = { put: vi.fn(), get: vi.fn(), delete: del, signedUrl: vi.fn() };
  const service = createDraftsService({
    db: fakeDbForDelete(assetRows, countRows, captured),
    adsPlatform: {} as never,
    vault: {} as never,
    approvals: {} as never,
    storage: storage as never,
    scheduler: {} as never,
  });
  return { service, del, captured };
}

describe("DraftsService.deleteCreative (híbrido: arquiva se em uso, apaga se livre)", () => {
  it("asset inexistente / outra org → null (404), sem tocar o storage", async () => {
    const { service, del } = makeDeleteService([], []);
    expect(await service.deleteCreative(ORG, "acct-1", "asset-x")).toBeNull();
    expect(del).not.toHaveBeenCalled();
  });

  it("em uso (count>0) → ARQUIVA (archived:true), NÃO apaga blob nem linha", async () => {
    const { service, del, captured } = makeDeleteService([{ storageRef: "org/org-1/creatives/x.png" }], [{ n: 2 }]);
    expect(await service.deleteCreative(ORG, "acct-1", "asset-1")).toEqual({ ok: true, archived: true });
    expect(captured.archived).toBe(true);
    expect(captured.deleted).toBeUndefined();
    expect(del).not.toHaveBeenCalled();
  });

  it("livre (count=0) → APAGA o blob + a linha → {ok:true, archived:false}", async () => {
    const { service, del, captured } = makeDeleteService([{ storageRef: "org/org-1/creatives/x.png" }], [{ n: 0 }]);
    expect(await service.deleteCreative(ORG, "acct-1", "asset-1")).toEqual({ ok: true, archived: false });
    expect(del).toHaveBeenCalledWith("org/org-1/creatives/x.png");
    expect(captured.deleted).toBe(true);
    expect(captured.archived).toBeUndefined();
  });

  it("livre sem storageRef (reuse) → {ok:true, archived:false} sem chamar storage.delete", async () => {
    const { service, del } = makeDeleteService([{ storageRef: null }], [{ n: 0 }]);
    expect(await service.deleteCreative(ORG, "acct-1", "asset-1")).toEqual({ ok: true, archived: false });
    expect(del).not.toHaveBeenCalled();
  });
});

describe("DraftsService.getCreativeBlob", () => {
  it("asset da própria org → faz stream do storage.get(storageRef)", async () => {
    const blob = { bytes: new Uint8Array([1, 2]), contentType: "image/png", etag: "abc" };
    const get = vi.fn().mockResolvedValue(blob);
    const { service } = makeService([{ storageRef: "org/org-1/creatives/x.png" }], get);
    const out = await service.getCreativeBlob(ORG, "acct-1", "asset-1");
    expect(get).toHaveBeenCalledWith("org/org-1/creatives/x.png");
    expect(out).toEqual(blob);
  });

  it("assetId de outro tenant (lookup org-scoped não casa) → null (404), NÃO vaza blob", async () => {
    const get = vi.fn();
    const { service } = makeService([], get); // where(orgId+accountId) não achou → []
    const out = await service.getCreativeBlob(ORG, "acct-1", "asset-de-outra-org");
    expect(out).toBeNull();
    expect(get).not.toHaveBeenCalled(); // nunca chega ao storage
  });

  it("asset sem storageRef (ex: reuse da Meta) → null (nada local pra servir)", async () => {
    const get = vi.fn();
    const { service } = makeService([{ storageRef: null }], get);
    expect(await service.getCreativeBlob(ORG, "acct-1", "asset-1")).toBeNull();
    expect(get).not.toHaveBeenCalled();
  });
});

describe("getDraftCreativeThumb (miniatura do criativo do rascunho)", () => {
  const reuseDraft = {
    spec: {
      version: 1,
      currency: "BRL",
      dailyBudgetMinor: 5000,
      activation: "active",
      creative: { assetId: "AD1", format: "video", origin: "reuse", metaVideoId: "VID9" },
    },
  };

  it("reuse + If-None-Match com ETag estável → 304 SEM tocar na Meta", async () => {
    const getVideoFrames = vi.fn();
    const service = createDraftsService({
      db: fakeDb([reuseDraft]),
      adsPlatform: { getVideoFrames } as never,
      vault: {} as never,
      approvals: {} as never,
      storage: {} as never,
      scheduler: {} as never,
    });
    const etag = createHash("sha256").update("draft-thumb:VID9").digest("hex").slice(0, 32);
    const out = await service.getDraftCreativeThumb(ORG, "acc", "draft-1", `"${etag}"`);
    expect(out).toEqual({ notModified: true, etag });
    expect(getVideoFrames).not.toHaveBeenCalled(); // revalidação não busca fresco
  });

  it("rascunho inexistente (ou de outro tenant) → null (404)", async () => {
    const service = createDraftsService({
      db: fakeDb([]),
      adsPlatform: {} as never,
      vault: {} as never,
      approvals: {} as never,
      storage: {} as never,
      scheduler: {} as never,
    });
    expect(await service.getDraftCreativeThumb(ORG, "acc", "nope")).toBeNull();
  });

  it("rascunho sem criativo (ex: duplicate) → null", async () => {
    const service = createDraftsService({
      db: fakeDb([{ spec: { version: 1, currency: "BRL", dailyBudgetMinor: 8000, activation: "active" } }]),
      adsPlatform: {} as never,
      vault: {} as never,
      approvals: {} as never,
      storage: {} as never,
      scheduler: {} as never,
    });
    expect(await service.getDraftCreativeThumb(ORG, "acc", "draft-dup")).toBeNull();
  });
});
