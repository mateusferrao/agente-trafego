import { describe, expect, it, vi } from "vitest";
import { autoApplyProactiveDraft } from "./apply-draft.js";
import type { WorkerDeps } from "../../composition.js";

// act_full CRIA sozinho mas NUNCA veicula (invariante CLAUDE.md §7/§8): a campanha nasce PAUSADA e
// a aprovação de ativação fica PENDENTE. `autoApplyProactiveDraft` não chama mais `applyActivation`
// — o mock existe só pra provar que a ativação NÃO é disparada sozinha.
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

  it("SEMPRE PAUSADA: com activation approval pendente → NÃO ativa sozinho; resolve só a de CRIAÇÃO, ativação fica pendente", async () => {
    const { deps, resolve } = fakeDeps([[CREATED_DRAFT], [{ id: "act-approval-1" }]]);
    const outcome = await autoApplyProactiveDraft(deps, { orgId: "o1", draftId: "d1", approvalId: "a1" });
    expect(outcome.kind).toBe("created");
    expect(applyActivationMock).not.toHaveBeenCalled(); // veiculação NUNCA é autônoma
    expect(resolve).toHaveBeenCalledWith("a1", { status: "approved" }); // criação aprovada
    expect(resolve).not.toHaveBeenCalledWith("act-approval-1", expect.anything()); // ativação pendente (OK humano)
  });

  it("mantém a approval pendente quando o rascunho não é encontrado (blocked)", async () => {
    const { deps, resolve } = fakeDeps([[]]);
    const outcome = await autoApplyProactiveDraft(deps, { orgId: "o1", draftId: "d1", approvalId: "a1" });
    expect(outcome.kind).toBe("blocked");
    expect(resolve).toHaveBeenCalledWith("a1", { status: "blocked", resolvedReason: expect.any(String) });
  });
});
