import { describe, expect, it, vi } from "vitest";
import type { WhatsappMediaIntakePayload } from "@trafego/shared";
import { makeMediaIntake, type MediaIntakeDeps } from "./whatsapp-media-intake.js";

const REF = { kind: "contact", contactId: "c1" } as const;
const PAYLOAD: WhatsappMediaIntakePayload = {
  orgId: "org-1",
  ref: REF,
  conversationId: "conv-1",
  instanceId: "inst-1",
  image: {
    base64: Buffer.from([1, 2, 3]).toString("base64"),
    mimetype: "image/png",
    caption: "logo",
    messageKey: { id: "m1", remoteJid: "5511@s.whatsapp.net", fromMe: false },
  },
};

const ACCOUNT = {
  metaAdAccountId: "act_123",
  name: "Loja X",
  currency: "BRL",
  tokenCripto: { v: 1 } as never,
};

/** db fake encadeável: select→from→where→limit devolve `selectRows`; insert→values registra. */
function fakeDb(selectRows: unknown[] = []) {
  const inserted: unknown[] = [];
  const db = {
    select: () => ({ from: () => ({ where: () => ({ limit: () => selectRows }) }) }),
    insert: () => ({ values: (v: unknown) => { inserted.push(v); return Promise.resolve(); } }),
  };
  return { db: db as unknown as MediaIntakeDeps["db"], inserted };
}

function makeDeps(over: Partial<MediaIntakeDeps> = {}, selectRows: unknown[] = []): {
  deps: MediaIntakeDeps;
  send: ReturnType<typeof vi.fn>;
  uploadImage: ReturnType<typeof vi.fn>;
  put: ReturnType<typeof vi.fn>;
  inserted: unknown[];
} {
  const send = vi.fn().mockResolvedValue(true);
  const uploadImage = vi.fn().mockResolvedValue({ imageHash: "HASH1" });
  const put = vi.fn().mockResolvedValue({ ref: "org/org-1/creatives/x.png", contentType: "image/png", sizeBytes: 3 });
  const { db, inserted } = fakeDb(selectRows);
  const deps: MediaIntakeDeps = {
    db,
    repo: { contextAdAccountId: vi.fn().mockResolvedValue("acct-uuid") },
    analysisRepo: { loadAccount: vi.fn().mockResolvedValue(ACCOUNT) },
    ports: {
      ads: { uploadImage },
      messaging: { fetchMediaBase64: vi.fn().mockResolvedValue(null) },
      vault: { decrypt: vi.fn().mockReturnValue("tok") },
      storage: { put, get: vi.fn(), signedUrl: vi.fn() },
    },
    sendToConversation: send,
    logger: { debug: vi.fn(), warn: vi.fn() },
    ...over,
  };
  return { deps, send, uploadImage, put, inserted };
}

describe("makeMediaIntake", () => {
  it("happy: grava blob, sobe pra Meta, insere asset e confirma", async () => {
    const { deps, send, uploadImage, put, inserted } = makeDeps();
    await makeMediaIntake(deps)(PAYLOAD);

    expect(put).toHaveBeenCalledWith(expect.objectContaining({ keyPrefix: "org/org-1/creatives", contentType: "image/png" }));
    expect(uploadImage).toHaveBeenCalledWith({ adAccountId: "act_123", accessToken: "tok" }, expect.objectContaining({ filename: "logo.png" }));
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({ origin: "upload", format: "image", metaImageHash: "HASH1", storageRef: "org/org-1/creatives/x.png" });
    expect(send).toHaveBeenCalledWith(REF, expect.stringContaining("Loja X"), expect.anything());
  });

  it("sem conta em foco (org multi-conta) → pede a conta, não sobe nada", async () => {
    const { deps, send, uploadImage } = makeDeps({ repo: { contextAdAccountId: vi.fn().mockResolvedValue(null) } });
    await makeMediaIntake(deps)(PAYLOAD);
    expect(uploadImage).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledWith(REF, expect.stringContaining("de qual conta"), expect.anything());
  });

  it("sem base64 inline → busca por fetchMediaBase64 (fallback)", async () => {
    const fetchMediaBase64 = vi.fn().mockResolvedValue(Buffer.from([9]).toString("base64"));
    const uploadImage = vi.fn().mockResolvedValue({ imageHash: "H2" });
    const { deps } = makeDeps({
      ports: {
        ads: { uploadImage },
        messaging: { fetchMediaBase64 },
        vault: { decrypt: vi.fn().mockReturnValue("tok") },
        storage: { put: vi.fn().mockResolvedValue({ ref: "r", contentType: "image/png", sizeBytes: 1 }), get: vi.fn(), signedUrl: vi.fn() },
      },
    });
    await makeMediaIntake(deps)({ ...PAYLOAD, image: { ...PAYLOAD.image, base64: "" } });
    expect(fetchMediaBase64).toHaveBeenCalledWith({ instanceId: "inst-1" }, PAYLOAD.image.messageKey);
    expect(uploadImage).toHaveBeenCalled();
  });

  it("sem bytes em lugar nenhum → avisa e encerra (sem upload)", async () => {
    const { deps, send, uploadImage } = makeDeps({
      ports: {
        ads: { uploadImage: vi.fn() },
        messaging: { fetchMediaBase64: vi.fn().mockResolvedValue(null) },
        vault: { decrypt: vi.fn() },
        storage: { put: vi.fn(), get: vi.fn(), signedUrl: vi.fn() },
      },
    });
    await makeMediaIntake(deps)({ ...PAYLOAD, image: { ...PAYLOAD.image, base64: "" } });
    expect(uploadImage).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledWith(REF, expect.stringContaining("não consegui baixar"), expect.anything());
  });

  it("idempotente: asset já existe (mesmo image_hash) → não re-insere", async () => {
    const { deps, inserted, send } = makeDeps({}, [{ id: "existing" }]);
    await makeMediaIntake(deps)(PAYLOAD);
    expect(inserted).toHaveLength(0);
    expect(send).toHaveBeenCalledWith(REF, expect.stringContaining("Loja X"), expect.anything());
  });

  it("falha de upload → avisa e re-lança (BullMQ re-tenta)", async () => {
    const boom = new Error("meta 500");
    const { deps, send } = makeDeps({
      ports: {
        ads: { uploadImage: vi.fn().mockRejectedValue(boom) },
        messaging: { fetchMediaBase64: vi.fn() },
        vault: { decrypt: vi.fn().mockReturnValue("tok") },
        storage: { put: vi.fn().mockResolvedValue({ ref: "r", contentType: "image/png", sizeBytes: 3 }), get: vi.fn(), signedUrl: vi.fn() },
      },
    });
    await expect(makeMediaIntake(deps)(PAYLOAD)).rejects.toThrow("meta 500");
    expect(send).toHaveBeenCalledWith(REF, expect.stringContaining("problema pra guardar"), expect.anything());
  });
});
