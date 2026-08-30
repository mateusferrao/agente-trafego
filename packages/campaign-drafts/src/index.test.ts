import type { CampaignDraftSpec } from "@trafego/shared";
import { describe, expect, it, vi } from "vitest";
import { applyExplicitGeoEdit, loadDraftForEdit, persistDraftSpec, resolveAudienceTargeting } from "./index.js";

const SPEC: CampaignDraftSpec = { version: 1, currency: "BRL", dailyBudgetMinor: 5000, activation: "paused" };
const REF = { draftId: "d1", orgId: "org-1" };

/**
 * db fake chainable. `selectRows` = o que o loadDraftForEdit lê; `updateReturns` = o que o UPDATE
 * ... RETURNING devolve (`[]` = 0 linhas → guardado por status barrou). `captured` guarda o set/where.
 */
function fakeDb(selectRows: unknown[] = [], updateReturns: unknown[] = [{ id: "d1" }]) {
  const captured: { setValue?: unknown } = {};
  const db = {
    select: () => ({ from: () => ({ where: () => ({ limit: () => selectRows }) }) }),
    update: () => ({
      set: (v: unknown) => {
        captured.setValue = v;
        return { where: () => ({ returning: () => updateReturns }) };
      },
    }),
  };
  return { db: db as unknown as Parameters<typeof persistDraftSpec>[0], captured };
}

describe("loadDraftForEdit", () => {
  it("devolve kind+spec quando proposed", async () => {
    const { db } = fakeDb([{ kind: "from_scratch", spec: SPEC, status: "proposed" }]);
    expect(await loadDraftForEdit(db, REF)).toEqual({ kind: "from_scratch", spec: SPEC });
  });

  it("devolve null quando NÃO está mais proposed (creating/created)", async () => {
    const { db } = fakeDb([{ kind: "from_scratch", spec: SPEC, status: "creating" }]);
    expect(await loadDraftForEdit(db, REF)).toBeNull();
  });

  it("devolve null quando não existe", async () => {
    const { db } = fakeDb([]);
    expect(await loadDraftForEdit(db, REF)).toBeNull();
  });
});

describe("persistDraftSpec — UPDATE guardado por status", () => {
  it("true quando o UPDATE guardado afeta a linha", async () => {
    const { db, captured } = fakeDb([], [{ id: "d1" }]);
    expect(await persistDraftSpec(db, REF, SPEC)).toBe(true);
    expect(captured.setValue).toEqual({ spec: SPEC });
  });

  it("false quando 0 linhas (rascunho já saiu de proposed durante a IO)", async () => {
    const { db } = fakeDb([], []);
    expect(await persistDraftSpec(db, REF, SPEC)).toBe(false);
  });
});

describe("resolveAudienceTargeting", () => {
  it("broad → advantage_plus (sem chamar o thunk de inferência)", async () => {
    const infer = vi.fn();
    expect(await resolveAudienceTargeting("broad", undefined, infer)).toEqual({ kind: "advantage_plus" });
    expect(infer).not.toHaveBeenCalled();
  });

  it("reuse com reuse_adset já no spec → mantém (sem chamar o thunk)", async () => {
    const infer = vi.fn();
    const current = { kind: "reuse_adset", sourceAdsetId: "as_1" } as const;
    expect(await resolveAudienceTargeting("reuse", current, infer)).toEqual(current);
    expect(infer).not.toHaveBeenCalled();
  });

  it("reuse sem herança → infere (thunk lazy)", async () => {
    const infer = vi.fn().mockResolvedValue("as_9");
    expect(await resolveAudienceTargeting("reuse", undefined, infer)).toEqual({ kind: "reuse_adset", sourceAdsetId: "as_9" });
  });

  it("reuse sem herança e sem fonte → mantém o atual (não força)", async () => {
    const infer = vi.fn().mockResolvedValue(undefined);
    expect(await resolveAudienceTargeting("reuse", undefined, infer)).toBeUndefined();
  });
});

describe("applyExplicitGeoEdit (Fase 1, subfatia 3a/3b — editar sem recriar o rascunho, chat+site)", () => {
  const base = {
    kind: "explicit" as const,
    geo: [
      { key: "1", name: "Belo Horizonte", kind: "city" as const },
      { key: "2", name: "Ibirité", kind: "city" as const },
      { key: "3", name: "Contagem", kind: "city" as const },
    ],
    ageMin: 25,
    ageMax: 45,
  };

  it("remove por nome (match parcial, case-insensitive) — sem chamada nova", () => {
    const r = applyExplicitGeoEdit(base, { removeGeo: ["ibirité"] });
    expect(r.kind).toBe("ok");
    if (r.kind === "ok" && r.targeting.kind === "explicit") {
      expect(r.targeting.geo.map((g) => g.name)).toEqual(["Belo Horizonte", "Contagem"]);
    }
  });

  it("nome não encontrado → BLOQUEIA (nunca aplica em interpretação incerta)", () => {
    const r = applyExplicitGeoEdit(base, { removeGeo: ["Betim"] });
    expect(r.kind).toBe("blocked");
    if (r.kind === "blocked") expect(r.reason).toContain("Betim");
  });

  it("adiciona geo já resolvida (dedupe por key)", () => {
    const r = applyExplicitGeoEdit(base, { addGeo: [{ key: "4", name: "Betim", kind: "city" }, { key: "1", name: "Belo Horizonte", kind: "city" }] });
    expect(r.kind).toBe("ok");
    if (r.kind === "ok" && r.targeting.kind === "explicit") {
      expect(r.targeting.geo).toHaveLength(4);
      expect(r.targeting.geo.map((g) => g.name)).toContain("Betim");
    }
  });

  it("estreita idade sem mexer em geo", () => {
    const r = applyExplicitGeoEdit(base, { ageMin: 30, ageMax: 40 });
    expect(r.kind).toBe("ok");
    if (r.kind === "ok" && r.targeting.kind === "explicit") {
      expect(r.targeting.ageMin).toBe(30);
      expect(r.targeting.ageMax).toBe(40);
      expect(r.targeting.geo).toHaveLength(3);
    }
  });
});
