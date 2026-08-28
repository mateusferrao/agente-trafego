import type { CampaignDraftSpec } from "@trafego/shared";
import { describe, expect, it, vi } from "vitest";
import { loadDraftForEdit, persistDraftSpec, resolveAudienceTargeting } from "./index.js";

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
  const ACCT = { adAccountId: "act_1", accessToken: "tok" };

  it("broad → advantage_plus (sem tocar na plataforma)", async () => {
    const ads = { inferCreationDefaults: vi.fn() };
    expect(await resolveAudienceTargeting(ads, ACCT, "broad", undefined)).toEqual({ kind: "advantage_plus" });
    expect(ads.inferCreationDefaults).not.toHaveBeenCalled();
  });

  it("reuse com reuse_adset já no spec → mantém (sem re-inferir)", async () => {
    const ads = { inferCreationDefaults: vi.fn() };
    const current = { kind: "reuse_adset", sourceAdsetId: "as_1" } as const;
    expect(await resolveAudienceTargeting(ads, ACCT, "reuse", current)).toEqual(current);
    expect(ads.inferCreationDefaults).not.toHaveBeenCalled();
  });

  it("reuse sem herança → infere ao vivo", async () => {
    const ads = { inferCreationDefaults: vi.fn().mockResolvedValue({ sourceAdsetId: "as_9" }) };
    expect(await resolveAudienceTargeting(ads, ACCT, "reuse", undefined)).toEqual({ kind: "reuse_adset", sourceAdsetId: "as_9" });
  });
});
