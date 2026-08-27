import { describe, expect, it, vi } from "vitest";
import {
  ingestCreativeImage,
  ingestCreativeVideo,
  type CreativeIngestDeps,
  type CreativeVideoIngestDeps,
} from "./index.js";

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

  it("dedupa por (conta, conteúdo) ANTES de subir: asset pronto já existe → reusa, não sobe nem insere", async () => {
    const { deps, inserted, uploadImage } = makeDeps([{ id: "existing", metaImageHash: "HASH1", metaVideoId: null }]);
    const out = await ingestCreativeImage(deps, INPUT);
    expect(inserted).toHaveLength(0);
    expect(uploadImage).not.toHaveBeenCalled(); // dedup antes do upload = poupa a chamada à Meta
    expect(out).toMatchObject({ assetId: "existing", metaImageHash: "HASH1", deduped: true });
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

function makeVideoDeps(selectRows: unknown[] = []) {
  const put = vi.fn().mockResolvedValue({ ref: "org/org-1/creatives/v.mp4", contentType: "video/mp4", sizeBytes: 3 });
  const uploadVideo = vi.fn().mockResolvedValue({ videoId: "VID1" });
  const { db, inserted } = fakeDb(selectRows);
  const deps: CreativeVideoIngestDeps = {
    db,
    storage: { put, get: vi.fn(), signedUrl: vi.fn() },
    ads: { uploadVideo },
  };
  return { deps, put, uploadVideo, inserted };
}

const VIDEO_INPUT = { ...INPUT, contentType: "video/mp4", filename: "ad.mp4" };

describe("ingestCreativeVideo", () => {
  it("sobe pra plataforma (video_id) + insere asset PENDING (processa async)", async () => {
    const { deps, uploadVideo, inserted } = makeVideoDeps();
    const out = await ingestCreativeVideo(deps, VIDEO_INPUT);
    expect(uploadVideo).toHaveBeenCalledWith(REF, expect.objectContaining({ filename: "ad.mp4" }));
    expect(inserted[0]).toMatchObject({ format: "video", status: "pending", metaVideoId: "VID1" });
    expect(out).toMatchObject({ assetId: "new-id", metaVideoId: "VID1", status: "pending", deduped: false });
  });

  it("dedup só reusa row PRONTA (metaVideoId): pending/failed não reusa", async () => {
    // row existente porém SEM metaVideoId (ex: pending/quebrada) → não reusa, sobe de novo.
    const { deps, uploadVideo } = makeVideoDeps([{ id: "half", metaImageHash: null, metaVideoId: null }]);
    const out = await ingestCreativeVideo(deps, VIDEO_INPUT);
    expect(uploadVideo).toHaveBeenCalled();
    expect(out).toMatchObject({ deduped: false });
  });

  it("dedup reusa quando há vídeo pronto (metaVideoId)", async () => {
    const { deps, uploadVideo } = makeVideoDeps([{ id: "existing", metaImageHash: null, metaVideoId: "VIDX" }]);
    const out = await ingestCreativeVideo(deps, VIDEO_INPUT);
    expect(uploadVideo).not.toHaveBeenCalled();
    expect(out).toMatchObject({ assetId: "existing", metaVideoId: "VIDX", status: "ready", deduped: true });
  });
});
