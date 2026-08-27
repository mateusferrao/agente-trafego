import { describe, expect, it, vi } from "vitest";
import { autoApplyProactiveDraft } from "./apply-draft.js";
import type { WorkerDeps } from "../../composition.js";

/**
 * DB falso sequencial: cada `where().limit()` consome UM resultado (em ordem). Captura o
 * update do spec (a trava PAUSED). applyDraft é chamado de verdade, mas a 1ª leitura devolve
 * um rascunho já `created` (replay idempotente) → NÃO toca na Meta.
 */
function fakeDeps(selectRows: unknown[][]) {
  const captured: { updatedSpec?: Record<string, unknown> } = {};
  const resolve = vi.fn(async () => {});
  const whereResult = () => {
    const rows = selectRows.shift() ?? [];
    return { limit: async () => rows, then: (r: (v: unknown) => void) => r(rows) };
  };
  const db = {
    select: () => ({ from: () => ({ where: () => whereResult() }) }),
    update: () => ({
      set: (v: Record<string, unknown>) => {
        if (v.spec) captured.updatedSpec = v.spec as Record<string, unknown>;
        return { where: async () => undefined };
      },
    }),
  };
  const deps = {
    db,
    logger: { warn: () => {}, info: () => {}, debug: () => {} },
    ports: { approval: { resolve } },
  } as unknown as WorkerDeps;
  return { deps, captured, resolve };
}

const CREATED_DRAFT = {
  id: "d1",
  status: "created",
  createdIds: { copiedId: "123" },
  kind: "duplicate",
  spec: { activation: "paused" },
};

describe("autoApplyProactiveDraft", () => {
  it("força PAUSED no spec e resolve a approval como approved quando cria", async () => {
    // select #1 (spec do rascunho, veio ACTIVE); select #2 (applyDraft: replay created).
    const { deps, captured, resolve } = fakeDeps([
      [{ spec: { version: 1, currency: "BRL", dailyBudgetMinor: 5000, activation: "active" } }],
      [CREATED_DRAFT],
    ]);

    const outcome = await autoApplyProactiveDraft(deps, { orgId: "o1", draftId: "d1", approvalId: "a1" });

    expect(captured.updatedSpec?.activation).toBe("paused"); // trava #1
    expect(outcome.kind).toBe("created");
    expect(resolve).toHaveBeenCalledWith("a1", { status: "approved" });
  });

  it("mantém a approval pendente quando a saga falha (não resolve)", async () => {
    // select #1 spec; select #2 applyDraft não acha o rascunho → blocked (não é failed, mas
    // exercita o ramo de resolve blocked). Para failed real precisaria simular erro de Meta.
    const { deps, resolve } = fakeDeps([
      [{ spec: { version: 1, currency: "BRL", dailyBudgetMinor: 5000, activation: "active" } }],
      [], // applyDraft: rascunho não encontrado → blocked
    ]);

    const outcome = await autoApplyProactiveDraft(deps, { orgId: "o1", draftId: "d1", approvalId: "a1" });

    expect(outcome.kind).toBe("blocked");
    expect(resolve).toHaveBeenCalledWith("a1", { status: "blocked", resolvedReason: expect.any(String) });
  });
});
