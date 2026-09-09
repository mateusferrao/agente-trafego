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
  // `.limit()` devolve `rows` (draft/conta); `.where()` sem limit (ex: bindings do applyPreview) é
  // awaitable → [] (sem bindings → applyPreview cai no default; estes testes não o asseguram).
  return {
    select: () => ({ from: () => ({ where: () => ({ limit: () => rows, then: (r: (v: unknown[]) => void) => r([]) }) }) }),
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

/** db fake p/ `loadScaleContext`: 1º select = adAccounts + 2 leftJoin → `.limit()` devolve `accRows`
 *  (vazio = ctx null, sem tocar Meta). Demais selects não são exercidos quando `accRows` é vazio. */
function fakeScaleContextDb(accRows: unknown[]) {
  return {
    select: () => ({
      from: () => ({
        leftJoin: () => ({
          leftJoin: () => ({ where: () => ({ limit: () => accRows }) }),
        }),
      }),
    }),
  } as never;
}

describe("DraftsService.searchGeo (Fase 1, subfatia 3b — autocomplete de geo)", () => {
  it("conta/agente não resolve (loadScaleContext null) → array vazio, honesto, sem erro", async () => {
    const service = createDraftsService({
      db: fakeScaleContextDb([]),
      adsPlatform: {} as never,
      vault: {} as never,
      approvals: {} as never,
      storage: {} as never,
      scheduler: {} as never,
    });
    const out = await service.searchGeo(ORG, "acc", "Belo Horizonte");
    expect(out).toEqual([]);
  });
});

describe("DraftsService.searchInterests (Fase 2, subfatia 4 — autocomplete de interesse)", () => {
  it("conta/agente não resolve (loadScaleContext null) → array vazio, honesto, sem erro", async () => {
    const service = createDraftsService({
      db: fakeScaleContextDb([]),
      adsPlatform: {} as never,
      vault: {} as never,
      approvals: {} as never,
      storage: {} as never,
      scheduler: {} as never,
    });
    const out = await service.searchInterests(ORG, "acc", "estetica");
    expect(out).toEqual([]);
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

describe("DraftsService.updateDraft — público EXPLÍCITO (Fase 1, subfatia 3b)", () => {
  /** select (draft) + update guardado, mesma forma de `fakeDbSelUpd` (setDraftTargeting). */
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

  const explicitSpec = {
    version: 1,
    currency: "BRL",
    dailyBudgetMinor: 5000,
    activation: "active",
    targeting: {
      kind: "explicit",
      geo: [{ key: "1", name: "Belo Horizonte", kind: "city" }, { key: "2", name: "Ibirité", kind: "city" }],
      ageMin: 25,
      ageMax: 45,
    },
  };

  it("removeGeo (nome exato do chip) → some do targeting, sem chamar a Meta", async () => {
    const captured: { spec?: unknown } = {};
    const service = createDraftsService({
      db: fakeDbSelUpd({ spec: explicitSpec, kind: "from_scratch", status: "proposed" }, captured),
      adsPlatform: {} as never,
      vault: {} as never,
      approvals: {} as never,
      storage: {} as never,
      scheduler: {} as never,
    });
    const out = await service.updateDraft(ORG, "acc", "d1", { removeGeo: ["Ibirité"] });
    expect(out.ok).toBe(true);
    const targeting = (captured.spec as { targeting: { geo: { name: string }[] } }).targeting;
    expect(targeting.geo.map((g) => g.name)).toEqual(["Belo Horizonte"]);
  });

  it("removeGeo com nome que não existe no rascunho → {ok:false}, NÃO persiste", async () => {
    const captured: { spec?: unknown } = {};
    const service = createDraftsService({
      db: fakeDbSelUpd({ spec: explicitSpec, kind: "from_scratch", status: "proposed" }, captured),
      adsPlatform: {} as never,
      vault: {} as never,
      approvals: {} as never,
      storage: {} as never,
      scheduler: {} as never,
    });
    const out = await service.updateDraft(ORG, "acc", "d1", { removeGeo: ["Betim"] });
    expect(out.ok).toBe(false);
    expect(captured.spec).toBeUndefined();
  });

  it("addGeo (já resolvido pelo autocomplete) → entra no targeting, sem chamar searchGeo de novo", async () => {
    const captured: { spec?: unknown } = {};
    const searchGeo = vi.fn();
    const service = createDraftsService({
      db: fakeDbSelUpd({ spec: explicitSpec, kind: "from_scratch", status: "proposed" }, captured),
      adsPlatform: { searchGeo } as never,
      vault: {} as never,
      approvals: {} as never,
      storage: {} as never,
      scheduler: {} as never,
    });
    const out = await service.updateDraft(ORG, "acc", "d1", { addGeo: [{ key: "3", name: "Contagem", kind: "city" }] });
    expect(out.ok).toBe(true);
    expect(searchGeo).not.toHaveBeenCalled();
    const targeting = (captured.spec as { targeting: { geo: { name: string }[] } }).targeting;
    expect(targeting.geo.map((g) => g.name)).toContain("Contagem");
  });

  it("ageMin/ageMax estreitam sem mexer na geo", async () => {
    const captured: { spec?: unknown } = {};
    const service = createDraftsService({
      db: fakeDbSelUpd({ spec: explicitSpec, kind: "from_scratch", status: "proposed" }, captured),
      adsPlatform: {} as never,
      vault: {} as never,
      approvals: {} as never,
      storage: {} as never,
      scheduler: {} as never,
    });
    const out = await service.updateDraft(ORG, "acc", "d1", { ageMin: 30, ageMax: 40 });
    expect(out.ok).toBe(true);
    const targeting = (captured.spec as { targeting: { ageMin: number; ageMax: number; geo: unknown[] } }).targeting;
    expect(targeting.ageMin).toBe(30);
    expect(targeting.ageMax).toBe(40);
    expect(targeting.geo).toHaveLength(2);
  });
});

describe("DraftsService.updateDraft — INTERESSES do público EXPLÍCITO (Fase 2, subfatia 4)", () => {
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

  const explicitSpecWithInterests = {
    version: 1,
    currency: "BRL",
    dailyBudgetMinor: 5000,
    activation: "active",
    targeting: {
      kind: "explicit",
      geo: [{ key: "1", name: "Belo Horizonte", kind: "city" }],
      interestGroups: [[{ id: "i1", name: "Estética" }, { id: "i2", name: "Pets" }]],
    },
  };

  it("removeInterests (nome exato do chip) → some do targeting, sem chamar a Meta", async () => {
    const captured: { spec?: unknown } = {};
    const service = createDraftsService({
      db: fakeDbSelUpd({ spec: explicitSpecWithInterests, kind: "from_scratch", status: "proposed" }, captured),
      adsPlatform: {} as never,
      vault: {} as never,
      approvals: {} as never,
      storage: {} as never,
      scheduler: {} as never,
    });
    const out = await service.updateDraft(ORG, "acc", "d1", { removeInterests: ["Pets"] });
    expect(out.ok).toBe(true);
    const targeting = (captured.spec as { targeting: { interestGroups: { name: string }[][] } }).targeting;
    expect(targeting.interestGroups.flat().map((i) => i.name)).toEqual(["Estética"]);
  });

  it("removeInterests com nome que não existe no rascunho → {ok:false}, NÃO persiste", async () => {
    const captured: { spec?: unknown } = {};
    const service = createDraftsService({
      db: fakeDbSelUpd({ spec: explicitSpecWithInterests, kind: "from_scratch", status: "proposed" }, captured),
      adsPlatform: {} as never,
      vault: {} as never,
      approvals: {} as never,
      storage: {} as never,
      scheduler: {} as never,
    });
    const out = await service.updateDraft(ORG, "acc", "d1", { removeInterests: ["Moda"] });
    expect(out.ok).toBe(false);
    expect(captured.spec).toBeUndefined();
  });

  it("addInterests (já resolvido pelo autocomplete) → entra no targeting, sem chamar searchInterests de novo", async () => {
    const captured: { spec?: unknown } = {};
    const searchInterests = vi.fn();
    const service = createDraftsService({
      db: fakeDbSelUpd({ spec: explicitSpecWithInterests, kind: "from_scratch", status: "proposed" }, captured),
      adsPlatform: { searchInterests } as never,
      vault: {} as never,
      approvals: {} as never,
      storage: {} as never,
      scheduler: {} as never,
    });
    const out = await service.updateDraft(ORG, "acc", "d1", { addInterests: [{ id: "i3", name: "Viagem" }] });
    expect(out.ok).toBe(true);
    expect(searchInterests).not.toHaveBeenCalled();
    const targeting = (captured.spec as { targeting: { interestGroups: { name: string }[][] } }).targeting;
    expect(targeting.interestGroups.flat().map((i) => i.name)).toContain("Viagem");
  });

  it("targeting não-explícito + removeInterests/addInterests → {ok:false} honesto", async () => {
    const captured: { spec?: unknown } = {};
    const nonExplicitSpec = { version: 1, currency: "BRL", dailyBudgetMinor: 5000, activation: "active", targeting: { kind: "advantage_plus" } };
    const service = createDraftsService({
      db: fakeDbSelUpd({ spec: nonExplicitSpec, kind: "from_scratch", status: "proposed" }, captured),
      adsPlatform: {} as never,
      vault: {} as never,
      approvals: {} as never,
      storage: {} as never,
      scheduler: {} as never,
    });
    const out = await service.updateDraft(ORG, "acc", "d1", { addInterests: [{ id: "i1", name: "Estética" }] });
    expect(out.ok).toBe(false);
    expect(captured.spec).toBeUndefined();
  });
});

describe("DraftsService.updateDraft — LINK de destino", () => {
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
  const svc = (draftRow: unknown, captured: { spec?: unknown }) =>
    createDraftsService({ db: fakeDbSelUpd(draftRow, captured), adsPlatform: {} as never, vault: {} as never, approvals: {} as never, storage: {} as never, scheduler: {} as never });
  const siteSpec = { version: 1, currency: "BRL", dailyBudgetMinor: 5000, activation: "paused", objective: "purchase", targeting: { kind: "advantage_plus" } };

  it("objetivo de site → grava o linkUrl no spec", async () => {
    const captured: { spec?: unknown } = {};
    const out = await svc({ spec: siteSpec, kind: "from_scratch", status: "proposed" }, captured).updateDraft(ORG, "acc", "d1", { linkUrl: "https://loja.com/promo" });
    expect(out.ok).toBe(true);
    expect((captured.spec as { linkUrl?: string }).linkUrl).toBe("https://loja.com/promo");
  });

  it("objetivo de conversas no WhatsApp → bloqueia honesto, NÃO persiste", async () => {
    const captured: { spec?: unknown } = {};
    const out = await svc({ spec: { ...siteSpec, objective: "messaging_started" }, kind: "from_scratch", status: "proposed" }, captured).updateDraft(ORG, "acc", "d1", { linkUrl: "https://loja.com/promo" });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.message).toMatch(/WhatsApp/i);
    expect(captured.spec).toBeUndefined();
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

describe("getCreativeThumb (miniatura da biblioteca — aba Criativos)", () => {
  it("IMAGEM pronta → faz stream do blob original (mesma fonte do /blob)", async () => {
    const blob = { bytes: new Uint8Array([1, 2]), contentType: "image/png", etag: "abc" };
    const get = vi.fn().mockResolvedValue(blob);
    const { service } = makeService(
      [{ format: "image", status: "ready", storageRef: "org/org-1/creatives/x.png", metaVideoId: null }],
      get,
    );
    const out = await service.getCreativeThumb(ORG, "acct-1", "asset-1");
    expect(get).toHaveBeenCalledWith("org/org-1/creatives/x.png");
    expect(out).toEqual(blob);
  });

  it("asset de outro tenant (lookup org-scoped não casa) → null (404)", async () => {
    const get = vi.fn();
    const { service } = makeService([], get);
    expect(await service.getCreativeThumb(ORG, "acct-1", "asset-de-outra-org")).toBeNull();
    expect(get).not.toHaveBeenCalled();
  });

  it("VÍDEO ainda processando (pending) → null SEM tocar na Meta (o card mostra 'processando…')", async () => {
    const getVideoFrames = vi.fn();
    const service = createDraftsService({
      db: fakeDb([{ format: "video", status: "pending", storageRef: null, metaVideoId: "V1" }]),
      adsPlatform: { getVideoFrames } as never,
      vault: {} as never,
      approvals: {} as never,
      storage: {} as never,
      scheduler: {} as never,
    });
    expect(await service.getCreativeThumb(ORG, "acc", "asset-1")).toBeNull();
    expect(getVideoFrames).not.toHaveBeenCalled();
  });

  it("VÍDEO pronto + If-None-Match com ETag estável → 304 SEM tocar na Meta", async () => {
    const getVideoFrames = vi.fn();
    const service = createDraftsService({
      db: fakeDb([{ format: "video", status: "ready", storageRef: null, metaVideoId: "VID9" }]),
      adsPlatform: { getVideoFrames } as never,
      vault: {} as never,
      approvals: {} as never,
      storage: {} as never,
      scheduler: {} as never,
    });
    const etag = createHash("sha256").update("creative-thumb:VID9").digest("hex").slice(0, 32);
    const out = await service.getCreativeThumb(ORG, "acc", "asset-1", `"${etag}"`);
    expect(out).toEqual({ notModified: true, etag });
    expect(getVideoFrames).not.toHaveBeenCalled(); // revalidação não busca fresco
  });
});

describe("getServingCreativeThumb (miniatura ESTÁVEL do anúncio da conta — picker)", () => {
  it("anúncio inexistente / outra org → null (404)", async () => {
    const { service } = makeService([]);
    expect(await service.getServingCreativeThumb(ORG, "acc", "nope")).toBeNull();
  });

  it("vídeo + If-None-Match com ETag estável (por video_id) → 304 SEM tocar na Meta", async () => {
    const getVideoFrames = vi.fn();
    const service = createDraftsService({
      db: fakeDb([{ videoId: "VID9", imageHash: null }]),
      adsPlatform: { getVideoFrames } as never,
      vault: {} as never,
      approvals: {} as never,
      storage: {} as never,
      scheduler: {} as never,
    });
    const etag = createHash("sha256").update("serving-thumb:VID9").digest("hex").slice(0, 32);
    const out = await service.getServingCreativeThumb(ORG, "acc", "AD1", `"${etag}"`);
    expect(out).toEqual({ notModified: true, etag });
    expect(getVideoFrames).not.toHaveBeenCalled(); // revalidação não busca fresco
  });
});

describe("listServingCreatives (candidatos de reuse: vídeo + imagem, por data — Slice 12)", () => {
  /** fakeDb p/ select→from→where→orderBy→limit AWAITADO. `rows` = já na ordem que o db devolveria. */
  function fakeDbAwait(rows: unknown[]) {
    const tail = { then: (r: (v: unknown[]) => void) => r(rows) };
    return {
      select: () => ({ from: () => ({ where: () => ({ orderBy: () => ({ limit: () => tail }) }) }) }),
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

  it("inclui VÍDEO (video_id) E IMAGEM (image_hash); descarta o que não tem nenhum", async () => {
    const service = makeServingService([
      { adId: "vid", title: "V", body: "cv", callToAction: "WHATSAPP", tier: "winner", videoId: "V1", imageHash: null, imageUrl: null, thumbnailUrl: "u1" },
      { adId: "img", title: "I", body: "ci", callToAction: null, tier: "performer", videoId: null, imageHash: "H1", imageUrl: "iu", thumbnailUrl: null },
      { adId: "none", title: "N", body: null, callToAction: null, tier: null, videoId: null, imageHash: null, imageUrl: null, thumbnailUrl: null },
    ]);
    const out = await service.listServingCreatives(ORG, "acc");
    expect(out.map((c) => c.adId)).toEqual(["vid", "img"]); // "none" (sem vídeo nem hash) sai
    expect(out[0]).toMatchObject({ format: "video" });
    expect(out[1]).toMatchObject({ format: "image", thumbnailUrl: "iu" }); // cai no imageUrl
  });

  it("preserva a ordem do db (por data desc — o db orderBy resolve)", async () => {
    const service = makeServingService([
      { adId: "novo", title: null, body: null, callToAction: null, tier: "performer", videoId: "V2", imageHash: null, imageUrl: null, thumbnailUrl: null },
      { adId: "velho", title: null, body: null, callToAction: null, tier: "winner", videoId: "V1", imageHash: null, imageUrl: null, thumbnailUrl: null },
    ]);
    const out = await service.listServingCreatives(ORG, "acc");
    expect(out.map((c) => c.adId)).toEqual(["novo", "velho"]);
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

  it("reuse quando o spec JÁ herda um conjunto COM retrato → mantém, sem chamar a Meta", async () => {
    const captured: { spec?: unknown } = {};
    const infer = vi.fn();
    // Bug 3 (Slice 0): reuse_adset SEM retrato re-resolve; COM retrato (resolved) é mantido sem tocar a Meta.
    const resolved = { geo: { countries: ["BR"] }, expansionRaw: { advantageAudience: 0, relaxCustomAudience: 0, relaxLookalike: 0 } };
    const targetingIn = { kind: "reuse_adset", sourceAdsetId: "AS1", resolved };
    const service = createDraftsService({
      db: fakeDbSelUpd(
        { spec: { version: 1, currency: "BRL", dailyBudgetMinor: 5000, activation: "active", targeting: targetingIn }, kind: "from_scratch", status: "proposed" },
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
    expect(infer).not.toHaveBeenCalled(); // já tem retrato → não re-infere
    expect((captured.spec as { targeting: unknown }).targeting).toEqual(targetingIn);
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

  it("rascunho duplicate → erro tipado com mensagem granular (não editável), não null cego", async () => {
    const service = createDraftsService({
      db: fakeDbSelUpd({ spec: {}, kind: "duplicate", status: "proposed" }, {}),
      adsPlatform: {} as never,
      vault: {} as never,
      approvals: {} as never,
      storage: {} as never,
      scheduler: {} as never,
    });
    const out = await service.setDraftTargeting(ORG, "acc", "d1", "broad");
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.message).toContain("escala"); // mensagem granular propagada (era 404 cego)
  });
});

/** db fake p/ listPendingDrafts: cada chain (select→from→where→limit) consome o próximo da fila
 *  (draft, depois conta, por item pendente). */
function fakeDbListQueue(queue: unknown[][]) {
  // `.limit()` puxa da fila; `.where()` sem limit (bindings do applyPreview) é awaitable → [].
  return {
    select: () => ({ from: () => ({ where: () => ({ limit: () => queue.shift() ?? [], then: (r: (v: unknown[]) => void) => r([]) }) }) }),
  } as never;
}

describe("DraftsService.listPendingDrafts — convertibleAudience (tolerância de rascunho antigo)", () => {
  function serviceWith(draftRow: unknown) {
    return createDraftsService({
      db: fakeDbListQueue([[draftRow], [{ name: "Conta X" }]]),
      adsPlatform: {} as never,
      vault: {} as never,
      approvals: { listPendingByOrg: vi.fn(async () => [{ id: "ap1", kind: "draft", draftId: "d1", status: "proposed", expiresAt: null }]) } as never,
      storage: {} as never,
      scheduler: {} as never,
    });
  }
  const baseSpec = { version: 1, currency: "BRL", dailyBudgetMinor: 5000, activation: "active" };

  it("reuse_adset SEM resolved (worker pré-snapshot) → convertível com semente vazia (editor abre)", async () => {
    const service = serviceWith({
      id: "d1", kind: "from_scratch", origin: "proactive", sourceRef: null, accountId: "acc1", createdIds: null,
      spec: { ...baseSpec, targeting: { kind: "reuse_adset", sourceAdsetId: "AS1" } },
    });
    const [out] = await service.listPendingDrafts(ORG);
    expect(out?.audience).toBe("reuse");
    expect(out?.convertibleAudience).toEqual({ geo: [], ageMin: null, ageMax: null });
  });

  it("reuse_adset COM resolved → semente herda geo/idade do retrato", async () => {
    const service = serviceWith({
      id: "d1", kind: "from_scratch", origin: "proactive", sourceRef: null, accountId: "acc1", createdIds: null,
      spec: { ...baseSpec, targeting: { kind: "reuse_adset", sourceAdsetId: "AS1", resolved: { geo: { cities: [{ key: "BR:SP", name: "São Paulo" }] }, ageMin: 25, ageMax: 45 } } },
    });
    const [out] = await service.listPendingDrafts(ORG);
    expect(out?.convertibleAudience?.ageMin).toBe(25);
    expect(out?.convertibleAudience?.ageMax).toBe(45);
    expect((out?.convertibleAudience?.geo ?? []).length).toBeGreaterThan(0);
  });
});

describe("DraftsService.updateDraft — nº de anúncios (add/remove preservando existentes)", () => {
  function fakeDbSelUpd(draftRow: unknown, captured: { spec?: unknown }) {
    return {
      select: () => ({ from: () => ({ where: () => ({ limit: () => (draftRow ? [draftRow] : []) }) }) }),
      update: () => ({ set: (v: { spec: unknown }) => { captured.spec = v.spec; return { where: () => ({ returning: () => [{ id: "d1" }] }) }; } }),
    } as never;
  }
  const specWithAds = {
    version: 1, currency: "BRL", dailyBudgetMinor: 5000, activation: "active",
    creative: { assetId: "def", format: "image", origin: "reuse", metaImageHash: "H" },
    variantsCount: 2,
    copyVariants: [
      { primaryText: "p1", headline: "h1" },
      { primaryText: "p2", headline: "h2", creative: { assetId: "own", format: "image", origin: "upload", metaImageHash: "H2" } },
    ],
  };
  function svc(captured: { spec?: unknown }) {
    return createDraftsService({
      db: fakeDbSelUpd({ spec: specWithAds, kind: "from_scratch", status: "proposed" }, captured),
      adsPlatform: {} as never, vault: {} as never, approvals: {} as never, storage: {} as never, scheduler: {} as never,
    });
  }

  it("addAd → duplica o último anúncio (copy + criativo próprio), preserva os existentes", async () => {
    const captured: { spec?: unknown } = {};
    const out = await svc(captured).updateDraft(ORG, "acc", "d1", { addAd: true });
    expect(out.ok).toBe(true);
    const cv = (captured.spec as { copyVariants: { headline: string; creative?: { assetId: string } }[] }).copyVariants;
    expect(cv.map((c) => c.headline)).toEqual(["h1", "h2", "h2"]);
    expect(cv[2]?.creative?.assetId).toBe("own"); // duplicou o criativo próprio do último
  });

  it("removeAdIndex → remove o anúncio indicado, preserva os demais", async () => {
    const captured: { spec?: unknown } = {};
    const out = await svc(captured).updateDraft(ORG, "acc", "d1", { removeAdIndex: 0 });
    expect(out.ok).toBe(true);
    const cv = (captured.spec as { copyVariants: { headline: string }[] }).copyVariants;
    expect(cv.map((c) => c.headline)).toEqual(["h2"]);
  });
});

describe("DraftsService.updateDraft — criativo POR ANÚNCIO (Fatia 7, só site)", () => {
  /** fila de resultados de `.limit(1)`: 1º = rascunho, 2º = asset da biblioteca (resolveLibraryCreative). */
  function fakeDbQueue(rows: unknown[][], captured: { spec?: unknown }) {
    const q = [...rows];
    return {
      select: () => ({ from: () => ({ where: () => ({ limit: () => q.shift() ?? [] }) }) }),
      update: () => ({ set: (v: { spec: unknown }) => { captured.spec = v.spec; return { where: () => ({ returning: () => [{ id: "d1" }] }) }; } }),
    } as never;
  }
  const spec = {
    version: 1, currency: "BRL", dailyBudgetMinor: 5000, activation: "active",
    creative: { assetId: "def", format: "image", origin: "reuse", metaImageHash: "H" },
    copyVariants: [{ primaryText: "p1", headline: "h1" }, { primaryText: "p2", headline: "h2" }],
  };

  it("copyEdits com creative asset → resolve e grava o criativo próprio SÓ nesse anúncio", async () => {
    const captured: { spec?: unknown } = {};
    const service = createDraftsService({
      db: fakeDbQueue(
        [
          [{ spec, kind: "from_scratch", status: "proposed" }], // load do rascunho
          [{ format: "video", origin: "upload", status: "ready", metaImageHash: null, metaVideoId: "VID9" }], // asset
        ],
        captured,
      ),
      adsPlatform: {} as never, vault: {} as never, approvals: {} as never, storage: {} as never, scheduler: {} as never,
    });
    const out = await service.updateDraft(ORG, "acc", "d1", { copyEdits: [{ index: 1, creative: { kind: "asset", assetId: "asset-x" } }] });
    expect(out.ok).toBe(true);
    const cv = (captured.spec as { copyVariants: { creative?: { metaVideoId?: string } }[] }).copyVariants;
    expect(cv[0]?.creative).toBeUndefined(); // anúncio 0 intacto (sem próprio)
    expect(cv[1]?.creative?.metaVideoId).toBe("VID9"); // anúncio 1 ganhou o criativo próprio
  });

  it("asset inexistente/arquivado → {ok:false} amigável, NÃO persiste", async () => {
    const captured: { spec?: unknown } = {};
    const service = createDraftsService({
      db: fakeDbQueue([[{ spec, kind: "from_scratch", status: "proposed" }], []], captured),
      adsPlatform: {} as never, vault: {} as never, approvals: {} as never, storage: {} as never, scheduler: {} as never,
    });
    const out = await service.updateDraft(ORG, "acc", "d1", { copyEdits: [{ index: 0, creative: { kind: "asset", assetId: "gone" } }] });
    expect(out.ok).toBe(false);
    expect(captured.spec).toBeUndefined();
  });
});

describe("DraftsService.updateDraft — anúncios POR CONJUNTO (F2, override compartilhado)", () => {
  /** db p/ o caminho `input.adsets` (precisa de loadScaleContext válido além do load do rascunho):
   *  select 1 = loadDraftForEdit (.where().limit()); select 2 = conta (.leftJoin.leftJoin.where.limit);
   *  select 3 = guardrail ([] → default); select 4 = bindings (await → []). update = persist capturado. */
  function fakeDbConjunto(draftRow: unknown, captured: { spec?: unknown }) {
    let n = 0;
    const acctRow = { metaAdAccountId: "act_1", currency: "BRL", accountToken: "enc", connToken: null, agentId: "ag1", autonomyPolicy: {} };
    return {
      select: () => {
        n += 1;
        const call = n;
        return {
          from: () => ({
            leftJoin: () => ({ leftJoin: () => ({ where: () => ({ limit: () => (call === 2 ? [acctRow] : []) }) }) }),
            where: () => ({ limit: () => (call === 1 ? [draftRow] : []), then: (r: (v: unknown[]) => void) => r([]) }),
          }),
        };
      },
      update: () => ({ set: (v: { spec: unknown }) => { captured.spec = v.spec; return { where: () => ({ returning: () => [{ id: "d1" }] }) }; } }),
    } as never;
  }
  const specMulti = {
    version: 1, currency: "BRL", dailyBudgetMinor: 5000, activation: "active", budgetMode: "cbo",
    creative: { assetId: "def", format: "image", origin: "reuse", metaImageHash: "H" },
    variantsCount: 2,
    copyVariants: [{ primaryText: "p1", headline: "h1" }, { primaryText: "p2", headline: "h2" }],
    adsets: [
      { name: "A", targeting: { kind: "advantage_plus" } },
      { name: "B", targeting: { kind: "advantage_plus" }, copyVariants: [{ primaryText: "bp1", headline: "bh1" }, { primaryText: "bp2", headline: "bh2" }] },
    ],
  };
  function svc(captured: { spec?: unknown }) {
    return createDraftsService({
      db: fakeDbConjunto({ spec: specMulti, kind: "from_scratch", status: "proposed" }, captured),
      adsPlatform: {} as never, vault: { decrypt: () => "token" } as never, approvals: {} as never, storage: {} as never, scheduler: {} as never,
    });
  }

  it("copyEdits por conjunto → conjunto ganha override (compartilhado com o anúncio editado)", async () => {
    const captured: { spec?: unknown } = {};
    const out = await svc(captured).updateDraft(ORG, "acc", "d1", {
      adsets: [
        { name: "A", copyEdits: [{ index: 0, headline: "novo A" }] }, // override sobre os compartilhados
        { name: "B", keepCopyVariantsIndex: 1 }, // preserva o override existente
      ],
    });
    expect(out.ok).toBe(true);
    const adsets = (captured.spec as { adsets: { copyVariants?: { headline: string }[] }[] }).adsets;
    expect(adsets[0]?.copyVariants?.map((c) => c.headline)).toEqual(["novo A", "h2"]); // A: shared + edit
    expect(adsets[1]?.copyVariants?.map((c) => c.headline)).toEqual(["bh1", "bh2"]); // B: override preservado
  });

  it("sem copyEdits/keep → conjunto usa os anúncios COMPARTILHADOS (sem override)", async () => {
    const captured: { spec?: unknown } = {};
    const out = await svc(captured).updateDraft(ORG, "acc", "d1", { adsets: [{ name: "A" }, { name: "B" }] });
    expect(out.ok).toBe(true);
    const adsets = (captured.spec as { adsets: { copyVariants?: unknown }[] }).adsets;
    expect(adsets[0]?.copyVariants).toBeUndefined();
    expect(adsets[1]?.copyVariants).toBeUndefined(); // override antigo NÃO reaparece sem keep (substituição total)
  });
});
