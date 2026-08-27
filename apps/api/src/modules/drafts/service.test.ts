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
