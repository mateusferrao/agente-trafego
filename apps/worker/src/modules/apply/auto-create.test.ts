import { describe, expect, it, vi } from "vitest";
import { autoApplyProactiveDraft } from "./apply-draft.js";
import type { WorkerDeps } from "../../composition.js";

// applyActivation é mockado (não injetado) — o teste isola o wrapper `autoApplyProactiveDraft`
// sem precisar simular a cadeia inteira de queries da ativação (guardrail + loadAccount/join).
// vi.mock é hoisted pelo vitest — aplica mesmo com import estático acima.
const applyActivationMock = vi.fn();
vi.mock("./apply-activation.js", () => ({ applyActivation: (...args: unknown[]) => applyActivationMock(...args) }));

/**
 * db falso sequencial: cada `where().limit()`/`where()` (thenable) consome UM resultado (em
 * ordem). `applyDraft` é chamado de verdade; a 1ª leitura devolve um rascunho já `created`
 * (replay idempotente) → NÃO toca na Meta. A 2ª leitura (P0.1) é o lookup da activation
 * approval PENDENTE (novo, ver `apply-draft.ts`).
 */
function fakeDeps(selectRows: unknown[][]) {
  const resolve = vi.fn(async () => {});
  const queue = [...selectRows];
  const whereResult = () => {
    const rows = queue.shift() ?? [];
    return { limit: async () => rows, then: (r: (v: unknown) => void) => r(rows) };
  };
  const db = {
    select: () => ({ from: () => ({ where: () => whereResult() }) }),
  };
  const deps = {
    db,
    logger: { warn: () => {}, info: () => {}, debug: () => {} },
    ports: { approval: { resolve } },
  } as unknown as WorkerDeps;
  return { deps, resolve };
}

const CREATED_DRAFT = {
  id: "d1",
  status: "created",
  createdIds: { copiedId: "123" },
  kind: "duplicate",
};

describe("autoApplyProactiveDraft", () => {
  it("replay idempotente (já criado, sem activation pendente) → resolve a approval de CRIAÇÃO como approved", async () => {
    const { deps, resolve } = fakeDeps([[CREATED_DRAFT], []]);
    const outcome = await autoApplyProactiveDraft(deps, { orgId: "o1", draftId: "d1", approvalId: "a1" });
    expect(outcome.kind).toBe("created");
    expect(resolve).toHaveBeenCalledWith("a1", { status: "approved" });
    expect(applyActivationMock).not.toHaveBeenCalled();
  });

  it("P1.3: com activation approval pendente → encadeia applyActivation e resolve AS DUAS approvals (act_full ativa sozinho)", async () => {
    applyActivationMock.mockResolvedValueOnce({ kind: "activated", dryRun: false });
    const { deps, resolve } = fakeDeps([[CREATED_DRAFT], [{ id: "act-approval-1" }]]);
    const outcome = await autoApplyProactiveDraft(deps, { orgId: "o1", draftId: "d1", approvalId: "a1" });
    expect(outcome.kind).toBe("created");
    expect(applyActivationMock).toHaveBeenCalledWith(deps, { orgId: "o1", draftId: "d1" });
    expect(resolve).toHaveBeenCalledWith("a1", { status: "approved" });
    expect(resolve).toHaveBeenCalledWith("act-approval-1", { status: "approved" });
  });

  it("P1.3: ativação barrada/falhou → approval de ATIVAÇÃO fica pendente (não resolve)", async () => {
    applyActivationMock.mockResolvedValueOnce({ kind: "blocked", reason: "kill switch ativo" });
    const { deps, resolve } = fakeDeps([[CREATED_DRAFT], [{ id: "act-approval-1" }]]);
    await autoApplyProactiveDraft(deps, { orgId: "o1", draftId: "d1", approvalId: "a1" });
    expect(resolve).toHaveBeenCalledWith("a1", { status: "approved" }); // criação segue aprovada
    expect(resolve).not.toHaveBeenCalledWith("act-approval-1", expect.anything()); // ativação intocada
  });

  it("mantém a approval pendente quando o rascunho não é encontrado (blocked)", async () => {
    const { deps, resolve } = fakeDeps([[]]);
    const outcome = await autoApplyProactiveDraft(deps, { orgId: "o1", draftId: "d1", approvalId: "a1" });
    expect(outcome.kind).toBe("blocked");
    expect(resolve).toHaveBeenCalledWith("a1", { status: "blocked", resolvedReason: expect.any(String) });
  });
});
