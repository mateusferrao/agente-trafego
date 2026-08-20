import { and, eq, inArray } from "drizzle-orm";
import { adAccounts, agents, type Database } from "@trafego/db";
import type { ApprovalId, OrgId } from "@trafego/shared/types";
import type { ApprovalPort } from "@trafego/shared/ports";
import type { SchedulerPort } from "@trafego/shared/ports";
import { APPROVAL_APPLY_JOB, APPROVAL_APPLY_QUEUE } from "@trafego/shared";
import { badRequest, notFound } from "../../middleware/error-handler.js";
import type { ApprovalOutput, ResolveApprovalInput, ResolveApprovalOutput } from "./schema.js";

export interface ApprovalsDeps {
  readonly db: Database;
  readonly approvals: ApprovalPort;
  /** enfileira a aplicação (worker re-checa fresco + escreve). A API nunca escreve na Meta. */
  readonly scheduler: SchedulerPort;
}

/**
 * Slice de aprovações (HITL via site, 5b). Lista as pendentes da org (caixa de entrada
 * cross-conta) e resolve por-ação: aprovar → enfileira o apply-service (worker re-checa
 * o estado fresco + guardrail + escreve); rejeitar → resolve direto (sem escrita).
 */
export function createApprovalsService(deps: ApprovalsDeps) {
  /** agentId → { accountId, accountName } (rótulo da conta na caixa de entrada). */
  async function accountByAgent(
    agentIds: readonly string[],
  ): Promise<Map<string, { accountId: string; accountName: string }>> {
    const map = new Map<string, { accountId: string; accountName: string }>();
    if (agentIds.length === 0) return map;
    const rows = await deps.db
      .select({ agentId: agents.id, accountId: adAccounts.id, accountName: adAccounts.name })
      .from(agents)
      .innerJoin(adAccounts, eq(agents.adAccountId, adAccounts.id))
      .where(inArray(agents.id, [...agentIds]));
    for (const r of rows) {
      map.set(r.agentId, { accountId: r.accountId, accountName: r.accountName ?? r.accountId });
    }
    return map;
  }

  return {
    async listPending(orgId: OrgId): Promise<ApprovalOutput[]> {
      const pending = await deps.approvals.listPendingByOrg(orgId);
      const accounts = await accountByAgent([...new Set(pending.map((a) => a.agentId))]);
      return pending.map((a) => {
        const acc = accounts.get(a.agentId);
        return {
          id: a.id,
          accountId: acc?.accountId ?? "",
          accountName: acc?.accountName ?? "conta",
          entityLevel: a.entityLevel,
          entityId: a.entityId,
          entityName: a.action.target.name ?? null,
          type: a.actionType,
          reason: a.action.reason,
          status: a.status,
          expiresAt: a.expiresAt ? a.expiresAt.toISOString() : null,
        };
      });
    },

    async resolve(
      orgId: OrgId,
      approvalId: ApprovalId,
      input: ResolveApprovalInput,
    ): Promise<ResolveApprovalOutput> {
      const approval = await deps.approvals.getById(approvalId);
      if (!approval || approval.orgId !== orgId) throw notFound("Aprovação não encontrada.");
      if (approval.status !== "pending") throw badRequest("Essa aprovação já foi resolvida.");

      if (input.decision === "reject") {
        const resolved = await deps.approvals.resolve(approvalId, { status: "rejected" });
        return { id: resolved.id, status: resolved.status };
      }

      // aprovar: o WORKER re-checa fresco + aplica (escrita fora da casca HTTP).
      await deps.scheduler.enqueue({
        queue: APPROVAL_APPLY_QUEUE,
        name: APPROVAL_APPLY_JOB,
        payload: { orgId, approvalId },
      });
      return { id: approval.id, status: "pending" };
    },
  };
}
