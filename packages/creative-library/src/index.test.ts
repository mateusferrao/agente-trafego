import { describe, expect, it, vi } from "vitest";
import { ingestCreativeImage, type CreativeIngestDeps } from "./index.js";

const REF = { adAccountId: "act_1", accessToken: "tok" };
const INPUT = {
  orgId: "org-1",
  adAccountId: "acct-uuid",
  ref: REF,
  bytes: new Uint8Array([1, 2, 3]),
  contentType: "image/png",
  filename: "logo.png",
};

function fakeDb(selectRows: unknown[] = []) {
  const inserted: unknown[] = [];
  const db = {
    select: () => ({ from: () => ({ where: () => ({ limit: () => selectRows }) }) }),
    insert: () => ({ values: (v: unknown) => { inserted.push(v); return { returning: () => [{ id: "new-id" }] }; } }),
  };
  return { db: db as unknown as CreativeIngestDeps["db"], inserted };
}

function makeDeps(selectRows: unknown[] = []) {
  const put = vi.fn().mockResolvedValue({ ref: "org/org-1/creatives/abc.png", contentType: "image/png", sizeBytes: 3 });
  const uploadImage = vi.fn().mockResolvedValue({ imageHash: "HASH1" });
  const { db, inserted } = fakeDb(selectRows);
  const deps: CreativeIngestDeps = {
    db,
    storage: { put, get: vi.fn(), signedUrl: vi.fn() },
    ads: { uploadImage },
  };
  return { deps, put, uploadImage, inserted };
}

describe("ingestCreativeImage", () => {
  it("grava blob (StoragePort) + sobe pra plataforma + insere asset com storageRef", async () => {
    const { deps, put, uploadImage, inserted } = makeDeps();
    const out = await ingestCreativeImage(deps, INPUT);

    expect(put).toHaveBeenCalledWith(expect.objectContaining({ keyPrefix: "org/org-1/creatives", contentType: "image/png" }));
    expect(uploadImage).toHaveBeenCalledWith(REF, expect.objectContaining({ filename: "logo.png" }));
    expect(inserted[0]).toMatchObject({ origin: "upload", format: "image", metaImageHash: "HASH1", storageRef: "org/org-1/creatives/abc.png" });
    expect(out).toMatchObject({ assetId: "new-id", metaImageHash: "HASH1", deduped: false });
  });

  it("dedupa por (conta, hash): asset já existe → reusa, não insere", async () => {
    const { deps, inserted } = makeDeps([{ id: "existing" }]);
    const out = await ingestCreativeImage(deps, INPUT);
    expect(inserted).toHaveLength(0);
    expect(out).toMatchObject({ assetId: "existing", deduped: true });
  });

  it("persiste o blob ANTES de subir (StoragePort é o hedge do binário)", async () => {
    const order: string[] = [];
    const { deps } = makeDeps();
    (deps.storage.put as ReturnType<typeof vi.fn>).mockImplementation(async () => { order.push("put"); return { ref: "r", contentType: "image/png", sizeBytes: 3 }; });
    (deps.ads.uploadImage as ReturnType<typeof vi.fn>).mockImplementation(async () => { order.push("upload"); return { imageHash: "H" }; });
    await ingestCreativeImage(deps, INPUT);
    expect(order).toEqual(["put", "upload"]);
  });
});
