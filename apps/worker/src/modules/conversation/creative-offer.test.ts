import { describe, expect, it, vi } from "vitest";
import type { Database } from "@trafego/db/client";
import type { Redis } from "ioredis";
import { isSimpleAffirmation, stageCreativeOffer } from "./creative-offer.js";

/** db falso: `rows` = o que a query de rascunho pendente devolve. */
function fakeDb(rows: Array<{ id: string }>): Database {
  return {
    select: () => ({ from: () => ({ where: () => ({ orderBy: () => ({ limit: async () => rows }) }) }) }),
  } as unknown as Database;
}

describe("stageCreativeOffer (fonte única da oferta: intake-imagem + poll-vídeo)", () => {
  const args = { orgId: "o", adAccountId: "a", assetId: "asset-1", conversationId: "cv-1" };

  it("rascunho from_scratch aberto → oferta de USAR (draftId presente)", async () => {
    const set = vi.fn(async (..._a: unknown[]) => {});
    const redis = { set } as unknown as Redis;
    const res = await stageCreativeOffer({ db: fakeDb([{ id: "draft-9" }]), redis }, args);
    expect(res.draftId).toBe("draft-9");
    expect(String(set.mock.calls[0]?.[1])).toContain("draft-9");
  });

  it("sem rascunho → oferta de CRIAR (draftId null, sem draftId na oferta)", async () => {
    const set = vi.fn(async (..._a: unknown[]) => {});
    const redis = { set } as unknown as Redis;
    const res = await stageCreativeOffer({ db: fakeDb([]), redis }, args);
    expect(res.draftId).toBeNull();
    expect(String(set.mock.calls[0]?.[1])).not.toContain("draftId");
  });
});

describe("isSimpleAffirmation (só o 'sim' puro resolve a oferta; o resto vai pro turno normal)", () => {
  it("aceita afirmações simples e inequívocas", () => {
    for (const t of ["sim", "Sim!", "pode", "usa", "cria", "quero", "bora", "ok", "beleza", "👍", " sim. "]) {
      expect(isSimpleAffirmation(t)).toBe(true);
    }
  });

  it("recusa frases compostas/ambíguas (vão pro turno normal, não resolvem no automático)", () => {
    for (const t of ["sim, mas muda o budget pra 80", "não", "usa o outro criativo", "qual público?", "cria uma de venda com público X", ""]) {
      expect(isSimpleAffirmation(t)).toBe(false);
    }
  });
});
