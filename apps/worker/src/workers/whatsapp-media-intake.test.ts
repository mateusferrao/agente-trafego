import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Database } from "@trafego/db/client";
import type { WhatsappMediaIntakePayload } from "@trafego/shared";

// ── mocks de módulo: ingestão (biblioteca) + oferta (Redis+DB) ──────────────────────────────
const stageCreativeOffer = vi.fn(async () => ({ draftId: null as string | null }));
vi.mock("../modules/conversation/creative-offer.js", () => ({ stageCreativeOffer }));
const ingestCreativeImage = vi.fn(async () => ({ assetId: "asset-1", metaImageHash: "hash-1" }));
const ingestCreativeVideo = vi.fn();
vi.mock("@trafego/creative-library", () => ({ ingestCreativeImage, ingestCreativeVideo }));

const { makeMediaIntake } = await import("./whatsapp-media-intake.js");

const REF = { kind: "contact" as const, contactId: "c-1" };
const PAYLOAD: WhatsappMediaIntakePayload = {
  orgId: "org-1",
  conversationId: "cv-1",
  ref: REF,
  instanceId: "inst-1",
  mediaType: "image",
  media: { base64: "QUFBQQ==", mimetype: "image/jpeg", messageKey: {}, caption: undefined },
} as unknown as WhatsappMediaIntakePayload;

/** db falso: pendingFromScratchDraftId → nenhuma pendência (draftId null). */
function fakeDb(): Database {
  return {
    select: () => ({ from: () => ({ where: () => ({ orderBy: () => ({ limit: async () => [] }) }) }) }),
  } as unknown as Database;
}

function makeDeps(chatAdsWrites: boolean, resolveSaveAccount = vi.fn(async () => "acc-uuid" as string | null)) {
  const sendToConversation = vi.fn(async (_ref: unknown, _msg: string, _opts?: unknown) => true);
  return {
    deps: {
      db: fakeDb(),
      resolveSaveAccount,
      analysisRepo: { loadAccount: vi.fn(async () => ({ metaAdAccountId: "act_1", tokenCripto: "enc", name: "Loja" })) },
      ports: {
        ads: { uploadImage: vi.fn(), uploadVideo: vi.fn() },
        messaging: { fetchMediaBase64: vi.fn(async () => "") },
        vault: { decrypt: vi.fn(() => "token") },
        storage: {} as never,
        scheduler: { enqueue: vi.fn(async () => {}) },
      },
      maxWhatsappVideoBytes: 50 * 1024 * 1024,
      sendToConversation,
      redis: {} as never,
      chatAdsWrites,
      logger: { debug: vi.fn(), warn: vi.fn() },
    },
    sendToConversation,
  };
}

describe("makeMediaIntake — imagem × kill-switch da escrita conversacional (v1)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("chatAdsWrites OFF → salva na biblioteca, NÃO guarda oferta, aponta a plataforma", async () => {
    const { deps, sendToConversation } = makeDeps(false);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await makeMediaIntake(deps as any)(PAYLOAD);
    expect(ingestCreativeImage).toHaveBeenCalledOnce(); // biblioteca preservada
    expect(stageCreativeOffer).not.toHaveBeenCalled(); // sem oferta de criar/trocar
    const msg = sendToConversation.mock.calls[0]?.[1] as string;
    expect(msg).toContain("biblioteca");
    expect(msg).toContain("site");
  });

  it("chatAdsWrites ON → guarda a oferta (fecha o loop do Slice 7)", async () => {
    const { deps, sendToConversation } = makeDeps(true);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await makeMediaIntake(deps as any)(PAYLOAD);
    expect(ingestCreativeImage).toHaveBeenCalledOnce();
    expect(stageCreativeOffer).toHaveBeenCalledOnce();
    const msg = sendToConversation.mock.calls[0]?.[1] as string;
    expect(msg.toLowerCase()).toContain("sim"); // oferta pede um "sim"
  });

  it("conta AMBÍGUA (resolveSaveAccount → null: foco velho/nada em contexto) → PERGUNTA a conta, NÃO salva no palpite", async () => {
    const resolveSaveAccount = vi.fn(async () => null as string | null);
    const { deps, sendToConversation } = makeDeps(true, resolveSaveAccount);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await makeMediaIntake(deps as any)(PAYLOAD);
    expect(ingestCreativeImage).not.toHaveBeenCalled(); // nunca sobe pra conta errada
    const msg = sendToConversation.mock.calls[0]?.[1] as string;
    expect(msg.toLowerCase()).toContain("conta"); // pede a conta
  });
});
