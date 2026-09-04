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
  it("ensaio + ação não permitida → applyPreview.effect blocked (capacidade vence ensaio)", async () => {
    const service = makeService([
      { agentId: AGENT, accountId: "acc-1", accountName: "BM", currency: "BRL", accountStatus: "active", dryRun: true, killSwitch: false, allowedActions: ["pause_entity"], orgId: ORG },
    ]);
    const bud = (await service.listPending(ORG))[0]!;
    expect(bud.applyPreview.effect).toBe("blocked");
    expect(bud.applyPreview.message).toContain("ações permitidas");
  });

  it("ensaio + ação permitida → applyPreview.effect simulated", async () => {
    const service = makeService([
      { agentId: AGENT, accountId: "acc-1", accountName: "BM", currency: "BRL", accountStatus: "active", dryRun: true, killSwitch: false, allowedActions: ["adjust_budget"], orgId: ORG },
    ]);
    expect((await service.listPending(ORG))[0]!.applyPreview.effect).toBe("simulated");
  });

  it("getOutcome deriva a mensagem do desfecho na voz do Roy", async () => {
    const resolved = { ...pendingBudget(), status: "blocked", applyOutcome: "blocked", resolvedReason: "budget já ajustado hoje" } as unknown as Approval;
    const service = createApprovalsService({
      db: signalsDb([], []),
      approvals: { getById: vi.fn(async () => resolved) } as never,
      scheduler: {} as never,
      revertTtlDays: 7,
    });
    const out = await service.getOutcome(ORG, "ap-1" as never);
    expect(out.applyOutcome).toBe("blocked");
    expect(out.resolvedReason).toBe("budget já ajustado hoje");
    expect(out.outcomeMessage).toBe("Não apliquei (Leads — 8510): budget já ajustado hoje.");
  });

  it("getOutcome de RASCUNHO blocked → 'Não criei: motivo'", async () => {
    const draft = { id: "ap-d", orgId: ORG, kind: "draft", draftId: "d1", status: "blocked", applyOutcome: "blocked", resolvedReason: "sem página" } as unknown as Approval;
    const service = createApprovalsService({ db: signalsDb([], []), approvals: { getById: vi.fn(async () => draft) } as never, scheduler: {} as never, revertTtlDays: 7 });
    const out = await service.getOutcome(ORG, "ap-d" as never);
    expect(out.applyOutcome).toBe("blocked");
    expect(out.outcomeMessage).toBe("Não criei: sem página.");
  });

  it("getOutcome de ATIVAÇÃO applied → 'Ativei sua campanha'", async () => {
    const act = { id: "ap-a", orgId: ORG, kind: "activation", draftId: "d1", status: "approved", applyOutcome: "applied", resolvedReason: null } as unknown as Approval;
    const service = createApprovalsService({ db: signalsDb([], []), approvals: { getById: vi.fn(async () => act) } as never, scheduler: {} as never, revertTtlDays: 7 });
    const out = await service.getOutcome(ORG, "ap-a" as never);
    expect(out.outcomeMessage).toContain("Ativei sua campanha");
  });

  it("getOutcome com applyOutcome null → outcomeMessage null (ainda aplicando)", async () => {
    const service = createApprovalsService({
      db: signalsDb([], []),
      approvals: { getById: vi.fn(async () => pendingBudget()) } as never,
      scheduler: {} as never,
      revertTtlDays: 7,
    });
    const out = await service.getOutcome(ORG, "ap-1" as never);
    expect(out.applyOutcome).toBeNull();
    expect(out.outcomeMessage).toBeNull();
  });

  it("ação permitida por binding → actionAllowed:true; conta removida → accountAvailable:false", async () => {
    const service = makeService(
      [{ agentId: AGENT, accountId: "acc-1", accountName: "BM", currency: "BRL", accountStatus: "removed", dryRun: false, killSwitch: false, allowedActions: [], orgId: ORG }],
      [{ agentId: AGENT, toolKey: "adjust_budget", mode: "enabled" }],
    );
    const bud = (await service.listPending(ORG))[0]!;
    // conta removida → blocked (prioridade sobre a capacidade habilitada)
    expect(bud.applyPreview.effect).toBe("blocked");
    expect(bud.applyPreview.message).toContain("indisponível");
  });
});
