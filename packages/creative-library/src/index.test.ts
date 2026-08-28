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

/**
 * db fake: cada select().from().where().limit() consome UM resultado da fila `selectRows`
 * (1º = fast-path `findExistingAsset`; 2º, se o insert "conflitar", = re-select pós-conflito).
 * `insertReturns` controla o que o INSERT devolve (`[]` simula onConflictDoNothing SEM linha —
 * outro upload venceu a corrida). `updated`/`deleted` capturam update (reativar) / delete (self-heal de erro).
 */
function fakeDb(selectRows: unknown[][] = [], insertReturns: unknown[] = [{ id: "new-id" }]) {
  const queue = [...selectRows];
  const inserted: unknown[] = [];
  const updated: unknown[] = [];
  const deleted: unknown[] = [];
  const db = {
    select: () => ({ from: () => ({ where: () => ({ limit: () => queue.shift() ?? [] }) }) }),
    insert: () => ({
      values: (v: unknown) => {
        inserted.push(v);
        return { onConflictDoNothing: () => ({ returning: () => insertReturns }) };
      },
    }),
    update: () => ({ set: (v: unknown) => { updated.push(v); return { where: async () => undefined }; } }),
    delete: () => ({ where: async () => { deleted.push(true); } }),
  };
  return { db: db as unknown as CreativeIngestDeps["db"], inserted, updated, deleted };
}

function makeDeps(selectRows: unknown[][] = [], insertReturns: unknown[] = [{ id: "new-id" }]) {
  const put = vi.fn().mockResolvedValue({ ref: "org/org-1/creatives/abc.png", contentType: "image/png", sizeBytes: 3 });
  const uploadImage = vi.fn().mockResolvedValue({ imageHash: "HASH1" });
  const { db, inserted, updated, deleted } = fakeDb(selectRows, insertReturns);
  const deps: CreativeIngestDeps = {
    db,
    storage: { put, get: vi.fn(), delete: vi.fn(), signedUrl: vi.fn() },
    ads: { uploadImage },
  };
  return { deps, put, uploadImage, inserted, updated, deleted };
}

describe("ingestCreativeImage", () => {
  it("grava blob (StoragePort) + sobe pra plataforma + insere asset com storageRef", async () => {
    const { deps, put, uploadImage, inserted } = makeDeps([[]]);
    const out = await ingestCreativeImage(deps, INPUT);

    expect(put).toHaveBeenCalledWith(expect.objectContaining({ keyPrefix: "org/org-1/creatives", contentType: "image/png" }));
    expect(uploadImage).toHaveBeenCalledWith(REF, expect.objectContaining({ filename: "logo.png" }));
    expect(inserted[0]).toMatchObject({ origin: "upload", format: "image", metaImageHash: "HASH1", storageRef: "org/org-1/creatives/abc.png" });
    expect(out).toMatchObject({ assetId: "new-id", metaImageHash: "HASH1", deduped: false });
  });

  it("dedupa por (conta, conteúdo) ANTES de subir: asset pronto já existe → reusa, não sobe nem insere", async () => {
    const { deps, inserted, uploadImage } = makeDeps([[{ id: "existing", status: "ready", metaImageHash: "HASH1", metaVideoId: null, archivedAt: null }]]);
    const out = await ingestCreativeImage(deps, INPUT);
    expect(inserted).toHaveLength(0);
    expect(uploadImage).not.toHaveBeenCalled(); // dedup antes do upload = poupa a chamada à Meta
    expect(out).toMatchObject({ assetId: "existing", metaImageHash: "HASH1", deduped: true });
  });

  it("P0.2: re-upload do MESMO conteúdo já ARQUIVADO → reativa (limpa archivedAt) e reusa", async () => {
    const { deps, updated } = makeDeps([[{ id: "existing", status: "ready", metaImageHash: "HASH1", metaVideoId: null, archivedAt: new Date() }]]);
    const out = await ingestCreativeImage(deps, INPUT);
    expect(updated).toHaveLength(1);
    expect(updated[0]).toMatchObject({ archivedAt: null });
    expect(out).toMatchObject({ assetId: "existing", deduped: true });
  });

  it("P0.2: asset existente em ERROR (estado morto) → limpa a linha e insere de novo (self-heal)", async () => {
    const { deps, deleted, inserted, uploadImage } = makeDeps([[{ id: "dead", status: "error", metaImageHash: null, metaVideoId: null, archivedAt: null }]]);
    const out = await ingestCreativeImage(deps, INPUT);
    expect(deleted).toHaveLength(1);
    expect(uploadImage).toHaveBeenCalled();
    expect(inserted).toHaveLength(1);
    expect(out).toMatchObject({ deduped: false });
  });

  it("P0.2: CONFLITO real na corrida (2 uploads concorrentes do mesmo conteúdo) → reusa o vencedor, não duplica", async () => {
    // 1º select (fast-path) não acha nada → sobe pra Meta → INSERT conflita (outro upload venceu
    // a corrida entre o select e o insert) → re-select acha o vencedor.
    const { deps, inserted, uploadImage } = makeDeps(
      [[], [{ id: "winner", status: "ready", metaImageHash: "HASH_WINNER", metaVideoId: null, archivedAt: null }]],
      [], // onConflictDoNothing().returning() vazio = conflito
    );
    const out = await ingestCreativeImage(deps, INPUT);
    expect(uploadImage).toHaveBeenCalled(); // este chamador subiu à Meta (fica órfão lá, benigno)
    expect(inserted).toHaveLength(1); // tentou inserir; a linha NÃO foi criada (onConflictDoNothing)
    expect(out).toMatchObject({ assetId: "winner", metaImageHash: "HASH_WINNER", deduped: true });
  });

  it("persiste o blob ANTES de subir (StoragePort é o hedge do binário)", async () => {
    const order: string[] = [];
    const { deps } = makeDeps([[]]);
    (deps.storage.put as ReturnType<typeof vi.fn>).mockImplementation(async () => { order.push("put"); return { ref: "r", contentType: "image/png", sizeBytes: 3 }; });
    (deps.ads.uploadImage as ReturnType<typeof vi.fn>).mockImplementation(async () => { order.push("upload"); return { imageHash: "H" }; });
    await ingestCreativeImage(deps, INPUT);
    expect(order).toEqual(["put", "upload"]);
  });
});

function makeVideoDeps(selectRows: unknown[][] = [], insertReturns: unknown[] = [{ id: "new-id" }]) {
  const put = vi.fn().mockResolvedValue({ ref: "org/org-1/creatives/v.mp4", contentType: "video/mp4", sizeBytes: 3 });
  const uploadVideo = vi.fn().mockResolvedValue({ videoId: "VID1" });
  const { db, inserted, updated, deleted } = fakeDb(selectRows, insertReturns);
  const deps: CreativeVideoIngestDeps = {
    db,
    storage: { put, get: vi.fn(), delete: vi.fn(), signedUrl: vi.fn() },
    ads: { uploadVideo },
  };
  return { deps, put, uploadVideo, inserted, updated, deleted };
}

const VIDEO_INPUT = { ...INPUT, contentType: "video/mp4", filename: "ad.mp4" };

describe("ingestCreativeVideo", () => {
  it("sobe pra plataforma (video_id) + insere asset PENDING (processa async)", async () => {
    const { deps, uploadVideo, inserted } = makeVideoDeps([[]]);
    const out = await ingestCreativeVideo(deps, VIDEO_INPUT);
    expect(uploadVideo).toHaveBeenCalledWith(REF, expect.objectContaining({ filename: "ad.mp4" }));
    expect(inserted[0]).toMatchObject({ format: "video", status: "pending", metaVideoId: "VID1" });
    expect(out).toMatchObject({ assetId: "new-id", metaVideoId: "VID1", status: "pending", deduped: false });
  });

  it("existente sem id resolvível (estado anômalo, sem metaVideoId nem error) → lança CEDO, sem upload à toa", async () => {
    // linha existe (ocupa o slot do unique constraint) mas nunca terminou de gravar o id — não é
    // 'error' (não dá pra self-heal) nem tem vídeo usável (não dá pra dedupar). Nunca deveria
    // acontecer (o insert sempre grava o id junto do status), mas falhar alto ANTES de gastar um
    // upload à Meta é melhor que subir o vídeo pra um resultado que não vai ser usado.
    const { deps, uploadVideo } = makeVideoDeps([
      [{ id: "half", status: "pending", metaImageHash: null, metaVideoId: null, archivedAt: null }],
    ]);
    await expect(ingestCreativeVideo(deps, VIDEO_INPUT)).rejects.toThrow();
    expect(uploadVideo).not.toHaveBeenCalled();
  });

  it("dedup reusa vídeo PENDING (mid-flight) — evita re-upload/2ª poll chain da MESMA corrida", async () => {
    const { deps, uploadVideo } = makeVideoDeps([[{ id: "existing", status: "pending", metaImageHash: null, metaVideoId: "VIDX", archivedAt: null }]]);
    const out = await ingestCreativeVideo(deps, VIDEO_INPUT);
    expect(uploadVideo).not.toHaveBeenCalled();
    expect(out).toMatchObject({ assetId: "existing", metaVideoId: "VIDX", status: "pending", deduped: true });
  });

  it("dedup reusa quando há vídeo PRONTO (metaVideoId)", async () => {
    const { deps, uploadVideo } = makeVideoDeps([[{ id: "existing", status: "ready", metaImageHash: null, metaVideoId: "VIDX", archivedAt: null }]]);
    const out = await ingestCreativeVideo(deps, VIDEO_INPUT);
    expect(uploadVideo).not.toHaveBeenCalled();
    expect(out).toMatchObject({ assetId: "existing", metaVideoId: "VIDX", status: "ready", deduped: true });
  });

  it("P0.2: asset de vídeo em ERROR (Meta rejeitou) → limpa a linha e tenta de novo", async () => {
    const { deps, deleted, uploadVideo } = makeVideoDeps([[{ id: "dead", status: "error", metaImageHash: null, metaVideoId: null, archivedAt: null }]]);
    const out = await ingestCreativeVideo(deps, VIDEO_INPUT);
    expect(deleted).toHaveLength(1);
    expect(uploadVideo).toHaveBeenCalled();
    expect(out).toMatchObject({ deduped: false, status: "pending" });
  });

  it("P0.2: CONFLITO real (2 vídeos concorrentes) → reusa o vencedor, não duplica video_id/poll chain", async () => {
    const { deps, uploadVideo, inserted } = makeVideoDeps(
      [[], [{ id: "winner", status: "pending", metaImageHash: null, metaVideoId: "VID_WINNER", archivedAt: null }]],
      [],
    );
    const out = await ingestCreativeVideo(deps, VIDEO_INPUT);
    expect(uploadVideo).toHaveBeenCalled(); // este chamador subiu à Meta (video_id órfão lá, benigno)
    expect(inserted).toHaveLength(1);
    expect(out).toMatchObject({ assetId: "winner", metaVideoId: "VID_WINNER", status: "pending", deduped: true });
  });
});
