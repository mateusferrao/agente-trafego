import { describe, expect, it, vi } from "vitest";
import type { WorkerDeps } from "../../composition.js";
import { revertActionById } from "./revert-action.js";

/** fake db cujo select→limit resolve `rows`. */
function fakeDeps(rows: unknown[]) {
  const chain = {
    from: () => chain,
    innerJoin: () => chain,
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
