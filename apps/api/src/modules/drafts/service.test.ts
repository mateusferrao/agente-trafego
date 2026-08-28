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
 *  referências (via await direto). delete() é no-op. Cada `where` consome o próximo resultado. */
function fakeDbForDelete(assetRows: unknown[], countRows: unknown[]) {
  const queue = [assetRows, countRows];
  const where = () => {
    const rows = queue.shift() ?? [];
    return { limit: () => rows, then: (r: (v: unknown) => void) => r(rows) };
  };
  return {
    select: () => ({ from: () => ({ where }) }),
    delete: () => ({ where: async () => undefined }),
  } as never;
}

function makeDeleteService(assetRows: unknown[], countRows: unknown[]) {
  const del = vi.fn(async () => {});
  const storage = { put: vi.fn(), get: vi.fn(), delete: del, signedUrl: vi.fn() };
  const service = createDraftsService({
    db: fakeDbForDelete(assetRows, countRows),
    adsPlatform: {} as never,
    vault: {} as never,
    approvals: {} as never,
    storage: storage as never,
    scheduler: {} as never,
  });
  return { service, del };
}

describe("DraftsService.deleteCreative (guarda de referência)", () => {
  it("asset inexistente / outra org → null (404), sem tocar o storage", async () => {
    const { service, del } = makeDeleteService([], []);
    expect(await service.deleteCreative(ORG, "acct-1", "asset-x")).toBeNull();
    expect(del).not.toHaveBeenCalled();
  });

  it("em uso por rascunho/campanha (count>0) → {ok:false, referencedBy}, NÃO apaga", async () => {
    const { service, del } = makeDeleteService([{ storageRef: "org/org-1/creatives/x.png" }], [{ n: 2 }]);
    expect(await service.deleteCreative(ORG, "acct-1", "asset-1")).toEqual({ ok: false, referencedBy: 2 });
    expect(del).not.toHaveBeenCalled();
  });

  it("sem referências → apaga o blob no storage + a linha → {ok:true}", async () => {
    const { service, del } = makeDeleteService([{ storageRef: "org/org-1/creatives/x.png" }], [{ n: 0 }]);
    expect(await service.deleteCreative(ORG, "acct-1", "asset-1")).toEqual({ ok: true });
    expect(del).toHaveBeenCalledWith("org/org-1/creatives/x.png");
  });

  it("sem storageRef (reuse) e sem referências → {ok:true} sem chamar storage.delete", async () => {
    const { service, del } = makeDeleteService([{ storageRef: null }], [{ n: 0 }]);
    expect(await service.deleteCreative(ORG, "acct-1", "asset-1")).toEqual({ ok: true });
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
