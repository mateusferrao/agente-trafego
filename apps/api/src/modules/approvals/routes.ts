import type { FastifyPluginAsync } from "fastify";
import type { ApprovalId } from "@trafego/shared/types";
import { requireAuth } from "../../middleware/auth.js";
import { requireActiveAccess } from "../../middleware/access-gate.js";
import { requireOrgScope, orgIdOf } from "../../middleware/org-scope.js";
import { editApprovalActionInput, resolveApprovalInput } from "./schema.js";

/** Slice de aprovações: listar pendentes e resolver (fallback web do HITL). */
export const approvalsRoutes: FastifyPluginAsync = async (app) => {
  const service = app.container.services.approvals;
  const guard = { preHandler: [requireAuth, requireOrgScope, requireActiveAccess] };

  app.get("/approvals", guard, async (request) => {
    return service.listPending(orgIdOf(request));
  });

  app.get("/approvals/revertible", guard, async (request) => {
    return service.listRevertible(orgIdOf(request));
  });

  app.post("/approvals/:id/resolve", guard, async (request) => {
    const { id } = request.params as { id: string };
    const input = resolveApprovalInput.parse(request.body);
    return service.resolve(orgIdOf(request), id as ApprovalId, input);
  });

  // Editar o VALOR de uma ação adjust_budget pendente antes de aprovar (C, v1).
  app.patch("/approvals/:id/action", guard, async (request) => {
    const { id } = request.params as { id: string };
    const input = editApprovalActionInput.parse(request.body);
    return service.editAction(orgIdOf(request), id as ApprovalId, input);
  });
};
