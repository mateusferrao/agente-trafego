import type { Database } from "@trafego/db";
import type { ApprovalId, OrgId } from "@trafego/shared/types";
import type { ApprovalPort } from "@trafego/shared/ports";
import type { ApprovalOutput, ResolveApprovalInput } from "./schema.js";

export interface ApprovalsDeps {
  readonly db: Database;
  readonly approvals: ApprovalPort;
}

/**
 * Slice de aprovações (HITL §7/§8). Lista pendentes da org e resolve pela UI
 * (o caminho primário é conversacional no WhatsApp; aqui é o fallback web).
 */
export function createApprovalsService(deps: ApprovalsDeps) {
  return {
    async listPending(_orgId: OrgId): Promise<ApprovalOutput[]> {
      // TODO: select approvals where org_id = orgId and status = 'pending'.
      void deps.db;
      return [];
    },

    async resolve(
      _orgId: OrgId,
      approvalId: ApprovalId,
      input: ResolveApprovalInput,
    ): Promise<ApprovalOutput> {
      // TODO: validar ownership org antes de resolver; resume do grafo é disparado pelo worker.
      const resolved = await deps.approvals.resolve(approvalId, {
        approvedActionIds: input.approvedActionIds,
        rejectedActionIds: input.rejectedActionIds,
      });
      return {
        id: resolved.id,
        runId: resolved.runId,
        status: resolved.status,
        expiresAt: resolved.expiresAt.toISOString(),
      };
    },
  };
}
