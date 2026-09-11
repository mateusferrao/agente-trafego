import { describe, expect, it, vi } from "vitest";
import type { WorkerDeps } from "../../composition.js";
import { revertActionById, revertsAsCreation } from "./revert-action.js";

/** fake db cujo select→limit resolve `rows`. */
function fakeDeps(rows: unknown[]) {
  const chain = {
    from: () => chain,
    innerJoin: () => chain,
    leftJoin: () => chain,
    where: () => chain,
    limit: () => Promise.resolve(rows),
  };
  const deps = {
    db: { select: () => chain },
    logger: { warn: vi.fn(), info: vi.fn() },
    ports: { vault: { decrypt: vi.fn() }, ads: {}, metering: {} },
  } as unknown as WorkerDeps;
  return deps;
}

describe("revertActionById", () => {
  it("tool_call não encontrado (org-scoped) → reverted:false + motivo, sem tocar no vault", async () => {
    const deps = fakeDeps([]);
    const res = await revertActionById(deps, { orgId: "org1", toolCallId: "missing" });
    expect(res.reverted).toBe(false);
    expect(res.reason).toContain("não encontrada");
    expect((deps.ports.vault.decrypt as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });
});

describe("revertsAsCreation — roteamento do revert (teardown de criação × restore por drift)", () => {
  it("criação/escala/ANEXO → teardown (revertCreation)", () => {
    expect(revertsAsCreation("create_campaign")).toBe(true);
    expect(revertsAsCreation("duplicate_scale")).toBe(true);
    // regressão: o attach grava beforeState:null → precisa do teardown, não do restore por drift.
    expect(revertsAsCreation("attach_creative")).toBe(true);
  });
  it("as 4 ações (com before_state) → restore por drift (NÃO teardown)", () => {
    for (const k of ["pause_entity", "resume_entity", "set_status", "adjust_budget"]) expect(revertsAsCreation(k)).toBe(false);
  });
});
