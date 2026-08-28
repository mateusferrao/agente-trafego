import { describe, expect, it, vi } from "vitest";
import type { WhatsappMediaIntakePayload } from "@trafego/shared";
import { makeMediaIntake, type MediaIntakeDeps } from "./whatsapp-media-intake.js";

const REF = { kind: "contact", contactId: "c1" } as const;
const MESSAGE_KEY = { id: "m1", remoteJid: "5511@s.whatsapp.net", fromMe: false };

const IMAGE_PAYLOAD: WhatsappMediaIntakePayload = {
  orgId: "org-1",
  ref: REF,
  conversationId: "conv-1",
  instanceId: "inst-1",
  mediaType: "image",
  media: { base64: Buffer.from([1, 2, 3]).toString("base64"), mimetype: "image/png", caption: "logo", messageKey: MESSAGE_KEY },
};

const VIDEO_PAYLOAD: WhatsappMediaIntakePayload = {
  orgId: "org-1",
  ref: REF,
  conversationId: "conv-1",
  instanceId: "inst-1",
  mediaType: "video",
  media: { mimetype: "video/mp4", caption: "promo", messageKey: MESSAGE_KEY }, // sem base64 inline
};

const ACCOUNT = { metaAdAccountId: "act_123", name: "Loja X", currency: "BRL", tokenCripto: { v: 1 } as never };

/** db fake encadeável: select→from→where→limit devolve `selectRows`; insert→values registra. */
function fakeDb(selectRows: unknown[] = []) {
  const inserted: unknown[] = [];
  const db = {
    select: () => ({ from: () => ({ where: () => ({ limit: () => selectRows }) }) }),
    insert: () => ({ values: (v: unknown) => { inserted.push(v); return { returning: () => [{ id: "new-id" }] }; } }),
    update: () => ({ set: () => ({ where: () => Promise.resolve() }) }),
  };
  return { db: db as unknown as MediaIntakeDeps["db"], inserted };
}

const TEN_MB = 10 * 1024 * 1024;

function makeDeps(over: Partial<MediaIntakeDeps> = {}, selectRows: unknown[] = []): {
  deps: MediaIntakeDeps;
  send: ReturnType<typeof vi.fn>;
  uploadImage: ReturnType<typeof vi.fn>;
  uploadVideo: ReturnType<typeof vi.fn>;
  enqueue: ReturnType<typeof vi.fn>;
  put: ReturnType<typeof vi.fn>;
  inserted: unknown[];
} {
  const send = vi.fn().mockResolvedValue(true);
  const uploadImage = vi.fn().mockResolvedValue({ imageHash: "HASH1" });
  const uploadVideo = vi.fn().mockResolvedValue({ videoId: "VID1" });
  const enqueue = vi.fn().mockResolvedValue(undefined);
  const put = vi.fn().mockResolvedValue({ ref: "org/org-1/creatives/x", contentType: "image/png", sizeBytes: 3 });
  const fetchMediaBase64 = vi.fn().mockResolvedValue(Buffer.from([9, 9]).toString("base64"));
  const { db, inserted } = fakeDb(selectRows);
  const deps: MediaIntakeDeps = {
    db,
    repo: { contextAdAccountId: vi.fn().mockResolvedValue("acct-uuid") },
    analysisRepo: { loadAccount: vi.fn().mockResolvedValue(ACCOUNT) },
    ports: {
      ads: { uploadImage, uploadVideo },
      messaging: { fetchMediaBase64 },
      vault: { decrypt: vi.fn().mockReturnValue("tok") },
      storage: { put, get: vi.fn(), delete: vi.fn(), signedUrl: vi.fn() },
      scheduler: { enqueue },
    },
    maxWhatsappVideoBytes: TEN_MB,
    sendToConversation: send,
    logger: { debug: vi.fn(), warn: vi.fn() },
    ...over,
  };
  return { deps, send, uploadImage, uploadVideo, enqueue, put, inserted };
}

describe("makeMediaIntake — imagem", () => {
  it("happy: grava blob, sobe pra Meta, insere asset e confirma", async () => {
    const { deps, send, uploadImage, inserted } = makeDeps();
    await makeMediaIntake(deps)(IMAGE_PAYLOAD);
    expect(uploadImage).toHaveBeenCalledWith({ adAccountId: "act_123", accessToken: "tok" }, expect.objectContaining({ filename: "logo.png" }));
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({ origin: "upload", format: "image", metaImageHash: "HASH1" });
    expect(send).toHaveBeenCalledWith(REF, expect.stringContaining("Loja X"), expect.anything());
  });

  it("sem conta em foco → pede a conta, não sobe nada", async () => {
    const { deps, send, uploadImage } = makeDeps({ repo: { contextAdAccountId: vi.fn().mockResolvedValue(null) } });
    await makeMediaIntake(deps)(IMAGE_PAYLOAD);
    expect(uploadImage).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledWith(REF, expect.stringContaining("de qual conta"), expect.anything());
  });

  it("idempotente: asset já existe (mesmo conteúdo) → não re-insere", async () => {
    const { deps, inserted, send } = makeDeps({}, [{ id: "existing", metaImageHash: "HASH1", metaVideoId: null }]);
    await makeMediaIntake(deps)(IMAGE_PAYLOAD);
    expect(inserted).toHaveLength(0);
    expect(send).toHaveBeenCalledWith(REF, expect.stringContaining("Loja X"), expect.anything());
  });

  it("falha de upload → avisa e re-lança (BullMQ re-tenta)", async () => {
    const boom = new Error("meta 500");
    const { deps, send } = makeDeps();
    (deps.ports.ads.uploadImage as ReturnType<typeof vi.fn>).mockRejectedValue(boom);
    await expect(makeMediaIntake(deps)(IMAGE_PAYLOAD)).rejects.toThrow("meta 500");
    expect(send).toHaveBeenCalledWith(REF, expect.stringContaining("problema pra guardar"), expect.anything());
  });
});

describe("makeMediaIntake — vídeo", () => {
  it("busca bytes por messageKey (sem base64 inline), sobe pending e enfileira o poll", async () => {
    const { deps, uploadVideo, enqueue, inserted } = makeDeps();
    await makeMediaIntake(deps)(VIDEO_PAYLOAD);
    expect(uploadVideo).toHaveBeenCalled();
    expect(inserted[0]).toMatchObject({ format: "video", status: "pending", metaVideoId: "VID1" });
    expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({ queue: "creative-video-poll" }));
  });

  it("vídeo grande demais (> cap WhatsApp, checado PÓS-decode) → avisa e NÃO sobe", async () => {
    const big = Buffer.alloc(TEN_MB + 1).toString("base64");
    const { deps, send, uploadVideo, enqueue } = makeDeps();
    (deps.ports.messaging.fetchMediaBase64 as ReturnType<typeof vi.fn>).mockResolvedValue(big);
    await makeMediaIntake(deps)(VIDEO_PAYLOAD); // sem fileLength na metadata → fallback pós-decode
    expect(uploadVideo).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledWith(REF, expect.stringContaining("grande demais"), expect.anything());
  });

  it("P0.3: vídeo grande demais por fileLength da METADATA → recusa SEM baixar os bytes", async () => {
    const { deps, send, uploadVideo, enqueue } = makeDeps();
    const fetchMediaBase64 = deps.ports.messaging.fetchMediaBase64 as ReturnType<typeof vi.fn>;
    const payload: WhatsappMediaIntakePayload = {
      ...VIDEO_PAYLOAD,
      media: { ...VIDEO_PAYLOAD.media, fileLength: TEN_MB + 1 },
    };
    await makeMediaIntake(deps)(payload);
    expect(fetchMediaBase64).not.toHaveBeenCalled(); // nem tentou buscar os bytes
    expect(uploadVideo).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledWith(REF, expect.stringContaining("grande demais"), expect.anything());
  });

  it("P0.3: fileLength dentro do cap → segue normal (busca os bytes)", async () => {
    const { deps, uploadVideo } = makeDeps();
    const fetchMediaBase64 = deps.ports.messaging.fetchMediaBase64 as ReturnType<typeof vi.fn>;
    const payload: WhatsappMediaIntakePayload = {
      ...VIDEO_PAYLOAD,
      media: { ...VIDEO_PAYLOAD.media, fileLength: 1024 },
    };
    await makeMediaIntake(deps)(payload);
    expect(fetchMediaBase64).toHaveBeenCalled();
    expect(uploadVideo).toHaveBeenCalled();
  });

  it("sem bytes (fetch falhou) → avisa e encerra", async () => {
    const { deps, send, uploadVideo } = makeDeps();
    (deps.ports.messaging.fetchMediaBase64 as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    await makeMediaIntake(deps)(VIDEO_PAYLOAD);
    expect(uploadVideo).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledWith(REF, expect.stringContaining("não consegui baixar"), expect.anything());
  });
});
