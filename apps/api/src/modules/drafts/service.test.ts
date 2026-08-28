import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { OrgId } from "@trafego/shared/types";
import { createDraftsService, refineErrorMessage } from "./service.js";

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

describe("DraftsService.updateDraft (edição consolidada — Slice 7)", () => {
  it("rascunho não-aberto (load vazio) → {ok:false} com mensagem amigável, sem persistir", async () => {
    const { service } = makeService([]); // loadDraftForEdit não acha linha proposed
    const r = await service.updateDraft(ORG, "acct-1", "draft-x", { campaignName: "Nova" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.message).toMatch(/não está mais aberto/i);
  });
});

describe("refineErrorMessage (§13 — o quê + o que fazer, sem jargão cru)", () => {
  it("field_not_editable explica a fronteira da escala + o caminho (criar nova)", () => {
    expect(refineErrorMessage({ code: "field_not_editable", field: "objective" })).toMatch(/escala|criar uma campanha nova/i);
  });
  it("empty_variants pede pelo menos um anúncio", () => {
    expect(refineErrorMessage({ code: "empty_variants" })).toMatch(/pelo menos um anúncio/i);
  });
  it("objective_requires_pixel traduz 'pixel' e oferece objetivo viável", () => {
    const msg = refineErrorMessage({ code: "objective_requires_pixel", objective: "purchase" });
    expect(msg).toMatch(/pixel/i);
    expect(msg).toMatch(/mensagens|engajamento/i);
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

describe("listServingCreatives (candidatos de reuse no picker: só vídeo, ranqueado)", () => {
  /** fakeDb p/ select→from→where AWAITADO (sem .limit). */
  function fakeDbAwait(rows: unknown[]) {
    return {
      select: () => ({ from: () => ({ where: () => ({ then: (r: (v: unknown[]) => void) => r(rows) }) }) }),
    } as never;
  }
  function makeServingService(rows: unknown[]) {
    return createDraftsService({
      db: fakeDbAwait(rows),
      adsPlatform: {} as never,
      vault: {} as never,
      approvals: {} as never,
      storage: {} as never,
      scheduler: {} as never,
    });
  }

  it("filtra p/ VÍDEO (imagem ao vivo = fast-follow) e mapeia campos", async () => {
    const service = makeServingService([
      { adId: "vid_win", title: "Campeão", body: "copy campeã", callToAction: "WHATSAPP", tier: "winner", videoId: "V1", thumbnailUrl: "u1", spend: 100, cpa: 2, roas: 5 },
      { adId: "img_ad", title: "Imagem", body: "x", callToAction: null, tier: "performer", videoId: null, thumbnailUrl: "u2", spend: 50, cpa: 4, roas: 3 },
    ]);
    const out = await service.listServingCreatives(ORG, "acc");
    expect(out).toHaveLength(1); // a imagem (videoId null) sai
    expect(out[0]).toMatchObject({ adId: "vid_win", format: "video", copy: "copy campeã", cta: "WHATSAPP", tier: "winner" });
  });

  it("ranqueia campeã→pior (winner antes de performer)", async () => {
    const service = makeServingService([
      { adId: "perf", title: null, body: null, callToAction: null, tier: "performer", videoId: "V2", thumbnailUrl: null, spend: 30, cpa: 6, roas: 2 },
      { adId: "win", title: null, body: null, callToAction: null, tier: "winner", videoId: "V1", thumbnailUrl: null, spend: 100, cpa: 2, roas: 5 },
    ]);
    const out = await service.listServingCreatives(ORG, "acc");
    expect(out.map((c) => c.adId)).toEqual(["win", "perf"]);
  });
});

describe("setDraftTargeting (alterna público reuse × amplo)", () => {
  /** db com select (draft, p/ loadDraftForEdit) + update GUARDADO (persistDraftSpec usa
   *  .where().returning()); captura o spec gravado e devolve 1 linha (write efetivado). */
  function fakeDbSelUpd(draftRow: unknown, captured: { spec?: unknown }) {
    return {
      select: () => ({ from: () => ({ where: () => ({ limit: () => (draftRow ? [draftRow] : []) }) }) }),
      update: () => ({
        set: (v: { spec: unknown }) => {
          captured.spec = v.spec;
          return { where: () => ({ returning: () => [{ id: "d1" }] }) };
        },
      }),
    } as never;
  }

  it("reuse quando o spec JÁ herda um conjunto → mantém, sem chamar a Meta", async () => {
    const captured: { spec?: unknown } = {};
    const infer = vi.fn();
    const service = createDraftsService({
      db: fakeDbSelUpd(
        { spec: { version: 1, currency: "BRL", dailyBudgetMinor: 5000, activation: "active", targeting: { kind: "reuse_adset", sourceAdsetId: "AS1" } }, kind: "from_scratch", status: "proposed" },
        captured,
      ),
      adsPlatform: { inferCreationDefaults: infer } as never,
      vault: {} as never,
      approvals: {} as never,
      storage: {} as never,
      scheduler: {} as never,
    });
    const out = await service.setDraftTargeting(ORG, "acc", "d1", "reuse");
    expect(out).toEqual({ ok: true, audience: "reuse" });
    expect(infer).not.toHaveBeenCalled(); // já herda → não re-infere
    expect((captured.spec as { targeting: unknown }).targeting).toEqual({ kind: "reuse_adset", sourceAdsetId: "AS1" });
  });

  it("broad → Advantage+ (a Meta escolhe), sem tocar na Meta", async () => {
    const captured: { spec?: unknown } = {};
    const service = createDraftsService({
      db: fakeDbSelUpd(
        { spec: { version: 1, currency: "BRL", dailyBudgetMinor: 5000, activation: "active", targeting: { kind: "reuse_adset", sourceAdsetId: "AS1" } }, kind: "from_scratch", status: "proposed" },
        captured,
      ),
      adsPlatform: {} as never,
      vault: {} as never,
      approvals: {} as never,
      storage: {} as never,
      scheduler: {} as never,
    });
    const out = await service.setDraftTargeting(ORG, "acc", "d1", "broad");
    expect(out).toEqual({ ok: true, audience: "broad" });
    expect((captured.spec as { targeting: unknown }).targeting).toEqual({ kind: "advantage_plus" });
  });

  it("rascunho não-proposto/duplicate → null (não editável)", async () => {
    const service = createDraftsService({
      db: fakeDbSelUpd({ spec: {}, kind: "duplicate", status: "proposed" }, {}),
      adsPlatform: {} as never,
      vault: {} as never,
      approvals: {} as never,
      storage: {} as never,
      scheduler: {} as never,
    });
    expect(await service.setDraftTargeting(ORG, "acc", "d1", "broad")).toBeNull();
  });
});
