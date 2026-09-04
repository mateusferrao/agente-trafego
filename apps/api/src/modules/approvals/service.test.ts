import { describe, expect, it, vi } from "vitest";
import { adAccounts, agentToolBindings } from "@trafego/db";
import type { OrgId } from "@trafego/shared/types";
import type { Approval } from "@trafego/shared/ports";
import { createApprovalsService } from "./service.js";

const ORG = "org-1" as OrgId;
const AGENT = "ag-1";

/** Aprovação de AÇÃO pendente mínima (só o que o listPending lê). */
function pendingBudget(): Approval {
  return {
    id: "ap-1",
    orgId: ORG,
    agentId: AGENT,
    kind: "action",
    runId: "run-1",
    entityLevel: "adset",
    entityId: "120",
    actionType: "adjust_budget",
    action: { id: "x", type: "adjust_budget", target: { level: "adset", id: "120", name: "Leads — 8510" }, params: {}, source: "llm", riskLevel: "medium", reason: "escala" },
    status: "pending",
    expiresAt: null,
    applyOutcome: null,
    resolvedReason: null,
  } as unknown as Approval;
}

/** db falso: `from(agentToolBindings)` → bindings; qualquer outro `from` → a linha de sinais. */
function signalsDb(signalRows: unknown[], bindingRows: unknown[]) {
  let target: unknown[] = [];
  const chain: Record<string, unknown> = {
    select: () => chain,
    from: (t: unknown) => {
      target = t === agentToolBindings ? bindingRows : signalRows;
      return chain;
    },
    innerJoin: () => chain,
    leftJoin: () => chain,
    where: () => chain,
    limit: () => chain,
    then: (resolve: (v: unknown[]) => unknown) => resolve(target),
  };
  return chain as never;
}

function makeService(signalRows: unknown[], bindingRows: unknown[] = []) {
  return createApprovalsService({
    db: signalsDb(signalRows, bindingRows),
    approvals: { listPendingByOrg: vi.fn(async () => [pendingBudget()]) } as never,
    scheduler: {} as never,
    revertTtlDays: 7,
  });
}

describe("approvalsService.listPending — sinais do 'antes'", () => {
  it("ensaio ligado + ação não permitida → dryRun:true, actionAllowed:false", async () => {
    const service = makeService([
      { agentId: AGENT, accountId: "acc-1", accountName: "BM", currency: "BRL", accountStatus: "active", dryRun: true, killSwitch: false, allowedActions: ["pause_entity"], orgId: ORG },
    ]);
    const [bud] = await service.listPending(ORG);
    expect(bud.dryRun).toBe(true);
    expect(bud.killSwitch).toBe(false);
    expect(bud.actionAllowed).toBe(false);
    expect(bud.accountAvailable).toBe(true);
  });

  it("ação permitida por binding → actionAllowed:true; conta removida → accountAvailable:false", async () => {
    const service = makeService(
      [{ agentId: AGENT, accountId: "acc-1", accountName: "BM", currency: "BRL", accountStatus: "removed", dryRun: false, killSwitch: false, allowedActions: [], orgId: ORG }],
      [{ agentId: AGENT, toolKey: "adjust_budget", mode: "enabled" }],
    );
    const [bud] = await service.listPending(ORG);
    expect(bud.actionAllowed).toBe(true);
    expect(bud.accountAvailable).toBe(false);
    expect(bud.dryRun).toBe(false);
  });
});
