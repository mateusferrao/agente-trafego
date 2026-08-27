import { and, eq, gte, inArray } from "drizzle-orm";
import { adAccounts, agentRuns, agentToolCalls, agents, type Database } from "@trafego/db";
import type { ApprovalId, OrgId } from "@trafego/shared/types";
import type { Approval, ApprovalPort } from "@trafego/shared/ports";
import type { SchedulerPort } from "@trafego/shared/ports";
import { APPROVAL_APPLY_JOB, APPROVAL_APPLY_QUEUE } from "@trafego/shared";
import { badRequest, notFound } from "../../middleware/error-handler.js";
import { computeAppliedActions, DAY_MS } from "../../lib/applied-actions.js";
import type {
  ApprovalOutput,
  ResolveApprovalInput,
  ResolveApprovalOutput,
  RevertibleActionOutput,
} from "./schema.js";

export interface ApprovalsDeps {
  readonly db: Database;
  readonly approvals: ApprovalPort;
  /** enfileira a aplicação (worker re-checa fresco + escreve). A API nunca escreve na Meta. */
  readonly scheduler: SchedulerPort;
  /** janela (dias) em que "reverter" segue disponível (5b) — mesmo TTL da mini-surface. */
  readonly revertTtlDays: number;
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
      // Rascunhos de campanha (Fatia 7) têm sua própria superfície (card de rascunho);
      // este inbox de AÇÕES lista só as aprovações de ação.
      const pending = (await deps.approvals.listPendingByOrg(orgId)).filter(
        (a): a is Approval => a.kind === "action",
      );
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

    /**
     * Ações ainda ACIONÁVEIS quanto a reverter, cross-conta (dentro do TTL): as que
     * podem reverter agora + as barradas por drift aguardando "reverter mesmo assim".
     * Já revertidas/simuladas/fora do TTL não aparecem aqui (nada a fazer com elas) —
     * o histórico completo é a Timeline (6a). Sem fallback de nome por lookup (só o
     * `target.name` já embutido no tool_call) — cobre o caso comum; tool_calls muito
     * antigos sem nome caem pro id cru, como em qualquer lugar que já faz esse fallback.
     */
    async listRevertible(orgId: OrgId): Promise<RevertibleActionOutput[]> {
      const since = new Date(Date.now() - deps.revertTtlDays * DAY_MS);
      const rows = await deps.db
        .select({
          id: agentToolCalls.id,
          runId: agentToolCalls.runId,
          toolKey: agentToolCalls.toolKey,
          args: agentToolCalls.args,
          result: agentToolCalls.result,
          idempotencyKey: agentToolCalls.idempotencyKey,
          createdAt: agentToolCalls.createdAt,
          accountId: adAccounts.id,
          accountName: adAccounts.name,
        })
        .from(agentToolCalls)
        .innerJoin(agentRuns, eq(agentToolCalls.runId, agentRuns.id))
        .innerJoin(agents, eq(agentRuns.agentId, agents.id))
        .innerJoin(adAccounts, eq(agents.adAccountId, adAccounts.id))
        .where(and(eq(agentRuns.orgId, orgId), gte(agentToolCalls.createdAt, since)));

      const accountByToolCallId = new Map(rows.map((r) => [r.id, { accountId: r.accountId, accountName: r.accountName ?? r.accountId }]));
      const actions = computeAppliedActions(rows, deps.revertTtlDays, new Map());
      return actions
        .filter((a) => a.undoable || a.revertBlocked)
        .map((a) => {
          const acc = accountByToolCallId.get(a.toolCallId);
          return {
            toolCallId: a.toolCallId,
            accountId: acc?.accountId ?? "",
            accountName: acc?.accountName ?? "conta",
            type: a.type,
            targetLevel: a.targetLevel,
            targetId: a.targetId,
            targetName: a.targetName,
            undoable: a.undoable,
            revertBlocked: a.revertBlocked,
            revertBlockedReason: a.revertBlockedReason,
          };
        });
    },
  };
}
