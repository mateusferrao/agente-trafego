import { describe, expect, it } from "vitest";
import { createLearningsService } from "./service.js";

/**
 * DB fake que devolve `selectResult` em todo select e captura o `.set()` do update.
 * Suficiente p/ cobrir confirm/edit/forget (a matemática de confiança é testada no core).
 */
function fakeDb(selectResult: unknown[]) {
  const updates: Record<string, unknown>[] = [];
  const selectChain: unknown = new Proxy({}, {
    get(_t, prop) {
      if (prop === "then") return (res: (v: unknown) => void) => res(selectResult);
      return () => selectChain;
    },
  });
  const db = {
    select: () => selectChain,
    update: () => ({
      set: (payload: Record<string, unknown>) => {
        updates.push(payload);
        return { where: async () => undefined };
      },
    }),
  } as never;
  return { db, updates };
}

const ORG = "org-1" as never;

describe("createLearningsService", () => {
  it("confirm → marca confirmedByHuman e sobe a confiança", async () => {
    const { db, updates } = fakeDb([{ confidence: 0.3 }]);
    const svc = createLearningsService({ db, scheduler: {} as never, qualityDefaults: {} });
    const out = await svc.confirm(ORG, "agent-1", "lesson-1");
    expect(out).toEqual({ ok: true });
    expect(updates[0]?.confirmedByHuman).toBe(true);
    expect(updates[0]?.confidence as number).toBeGreaterThan(0.3);
  });

  it("forget → arquiva (soft)", async () => {
    const { db, updates } = fakeDb([{ confidence: 0.5 }]);
    const svc = createLearningsService({ db, scheduler: {} as never, qualityDefaults: {} });
    await svc.forget(ORG, "agent-1", "lesson-1");
    expect(updates[0]?.lifecycle).toBe("archived");
  });

  it("edit → atualiza o conteúdo", async () => {
    const { db, updates } = fakeDb([{ confidence: 0.5 }]);
    const svc = createLearningsService({ db, scheduler: {} as never, qualityDefaults: {} });
    await svc.edit(ORG, "agent-1", "lesson-1", "novo texto");
    expect(updates[0]?.content).toBe("novo texto");
  });

  it("lição inexistente → 404 (não faz update)", async () => {
    const { db, updates } = fakeDb([]); // select vazio
    const svc = createLearningsService({ db, scheduler: {} as never, qualityDefaults: {} });
    await expect(svc.confirm(ORG, "agent-1", "x")).rejects.toThrow();
    expect(updates).toHaveLength(0);
  });

  it("rejectProposal → descarta o patch e marca resolvido (sem tocar config)", async () => {
    const { db, updates } = fakeDb([{ patch: { threshold: "zombieMinSpend" } }]);
    const svc = createLearningsService({ db, scheduler: {} as never, qualityDefaults: {} });
    await svc.rejectProposal(ORG, "agent-1", "lesson-1");
    expect(updates[0]?.proposedThresholdPatch).toBeNull();
    expect(updates[0]?.thresholdResolvedAt).toBeDefined();
  });

  it("rejectProposal sem proposta pendente → erro (não faz update)", async () => {
    const { db, updates } = fakeDb([{ patch: null }]);
    const svc = createLearningsService({ db, scheduler: {} as never, qualityDefaults: {} });
    await expect(svc.rejectProposal(ORG, "agent-1", "lesson-1")).rejects.toThrow();
    expect(updates).toHaveLength(0);
  });

  it("revertThreshold sem ajuste aplicado → erro (não toca config)", async () => {
    const { db, updates } = fakeDb([{ applied: null, adAccountId: "acc-1" }]);
    const svc = createLearningsService({ db, scheduler: {} as never, qualityDefaults: {} });
    await expect(svc.revertThreshold(ORG, "agent-1", "lesson-1")).rejects.toThrow();
    expect(updates).toHaveLength(0);
  });
});
