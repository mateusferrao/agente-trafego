import type { CampaignDraftSpec, TargetingSpec } from "@trafego/shared";
import { describe, expect, it, vi } from "vitest";
import { applyExplicitGeoEdit, applyExplicitInterestEdit, loadDraftForEdit, persistDraftSpec, resolveAudienceTargeting } from "./index.js";

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
  const snapshot = { geo: { countries: ["BR"] }, expansionRaw: { advantageAudience: 0 as const, relaxCustomAudience: 0 as const, relaxLookalike: 0 as const } };
  const resolvedReuse = { kind: "reuse_adset" as const, sourceAdsetId: "as_9", resolved: snapshot };

  it("broad → advantage_plus (sem chamar o thunk de inferência)", async () => {
    const infer = vi.fn();
    expect(await resolveAudienceTargeting("broad", undefined, infer)).toEqual({ kind: "advantage_plus" });
    expect(infer).not.toHaveBeenCalled();
  });

  it("reuse com reuse_adset JÁ COM retrato → mantém (sem chamar o thunk)", async () => {
    const infer = vi.fn();
    const current = { kind: "reuse_adset", sourceAdsetId: "as_1", resolved: snapshot } as const;
    expect(await resolveAudienceTargeting("reuse", current, infer)).toEqual(current);
    expect(infer).not.toHaveBeenCalled();
  });

  it("reuse com reuse_adset SEM retrato → RE-resolve (nunca aplica cru → expansão AS-IS)", async () => {
    const infer = vi.fn().mockResolvedValue(resolvedReuse);
    const current = { kind: "reuse_adset", sourceAdsetId: "as_1" } as const;
    expect(await resolveAudienceTargeting("reuse", current, infer)).toEqual(resolvedReuse);
    expect(infer).toHaveBeenCalledOnce();
  });

  it("reuse sem herança → resolve com retrato (thunk lazy)", async () => {
    const infer = vi.fn().mockResolvedValue(resolvedReuse);
    expect(await resolveAudienceTargeting("reuse", undefined, infer)).toEqual(resolvedReuse);
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

  it("define gênero (bug e2e: antes o site descartava o toggle)", () => {
    const r = applyExplicitGeoEdit(base, { genders: [2] });
    expect(r.kind).toBe("ok");
    if (r.kind === "ok" && r.targeting.kind === "explicit") expect(r.targeting.genders).toEqual([2]);
  });

  it("limpa gênero com [] (volta a 'todos' — some do targeting)", () => {
    const r = applyExplicitGeoEdit({ ...base, genders: [1] }, { genders: [] });
    expect(r.kind).toBe("ok");
    if (r.kind === "ok" && r.targeting.kind === "explicit") expect(r.targeting.genders).toBeUndefined();
  });

  it("gênero ausente no patch → mantém o atual", () => {
    const r = applyExplicitGeoEdit({ ...base, genders: [1] }, { ageMin: 30 });
    expect(r.kind).toBe("ok");
    if (r.kind === "ok" && r.targeting.kind === "explicit") expect(r.targeting.genders).toEqual([1]);
  });
});

describe("applyExplicitInterestEdit (Slice 3 — grupos AND, editar sem recriar o rascunho, chat+site)", () => {
  const base = {
    kind: "explicit" as const,
    geo: [{ key: "1", name: "Belo Horizonte", kind: "city" as const }],
    interestGroups: [[
      { id: "i1", name: "Estética" },
      { id: "i2", name: "Pets" },
    ]],
  };
  const names = (t: TargetingSpec) => (t.kind === "explicit" ? (t.interestGroups ?? []).flat().map((i) => i.name) : []);

  it("remove por nome (entre grupos, case-insensitive)", () => {
    const r = applyExplicitInterestEdit(base, { removeInterests: ["pets"] });
    expect(r.kind).toBe("ok");
    if (r.kind === "ok") expect(names(r.targeting)).toEqual(["Estética"]);
  });

  it("remove o ÚLTIMO interesse → some a chave interestGroups", () => {
    const one = { ...base, interestGroups: [[{ id: "i1", name: "Estética" }]] };
    const r = applyExplicitInterestEdit(one, { removeInterests: ["estética"] });
    expect(r.kind).toBe("ok");
    if (r.kind === "ok" && r.targeting.kind === "explicit") expect(r.targeting.interestGroups).toBeUndefined();
  });

  it("nome não encontrado → BLOQUEIA", () => {
    const r = applyExplicitInterestEdit(base, { removeInterests: ["moda"] });
    expect(r.kind).toBe("blocked");
    if (r.kind === "blocked") expect(r.reason).toContain("moda");
  });

  it("addInterests → OR-widen no 1º grupo (dedupe por id)", () => {
    const r = applyExplicitInterestEdit(base, { addInterests: [{ id: "i3", name: "Viagem" }, { id: "i1", name: "Estética" }] });
    expect(r.kind).toBe("ok");
    if (r.kind === "ok" && r.targeting.kind === "explicit") {
      expect(r.targeting.interestGroups).toHaveLength(1);
      expect(names(r.targeting)).toContain("Viagem");
      expect(names(r.targeting)).toHaveLength(3);
    }
  });

  it("narrowInterests → novo grupo AND (estreita)", () => {
    const r = applyExplicitInterestEdit(base, { narrowInterests: [{ id: "i9", name: "Luxo" }] });
    expect(r.kind).toBe("ok");
    if (r.kind === "ok" && r.targeting.kind === "explicit") {
      expect(r.targeting.interestGroups).toHaveLength(2);
      expect(r.targeting.interestGroups?.[1]?.map((i) => i.name)).toEqual(["Luxo"]);
    }
  });

  it("addInterests num targeting SEM grupos ainda → cria o 1º grupo", () => {
    const none = { kind: "explicit" as const, geo: base.geo };
    const r = applyExplicitInterestEdit(none, { addInterests: [{ id: "i1", name: "Estética" }] });
    expect(r.kind).toBe("ok");
    if (r.kind === "ok") expect(names(r.targeting)).toEqual(["Estética"]);
  });
});
