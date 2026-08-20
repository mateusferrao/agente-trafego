import { and, eq, lt, sql } from "drizzle-orm";
import { approvals, type Database } from "@trafego/db";
import type {
  Approval,
  ApprovalPort,
  ResolveApprovalInput,
  UpsertPendingInput,
} from "@trafego/shared/ports";
import type {
  Action,
  ActionType,
  AgentId,
  ApprovalId,
  ContactId,
  EntityLevel,
  OrgId,
  RunId,
} from "@trafego/shared/types";

type Row = typeof approvals.$inferSelect;

/** Linha do banco → contrato de domínio (ids reidratados p/ os tipos branded). */
function toApproval(r: Row): Approval {
  return {
    id: r.id as ApprovalId,
    orgId: r.orgId as OrgId,
    agentId: r.agentId as AgentId,
    runId: (r.runId ?? null) as RunId | null,
    contactId: (r.contactId ?? null) as ContactId | null,
    status: r.status,
    entityLevel: r.entityLevel as EntityLevel,
    entityId: r.entityId,
    actionType: r.actionType as ActionType,
    action: r.action as Action,
    resolvedReason: r.resolvedReason ?? null,
    expiresAt: r.expiresAt ?? new Date(0),
    createdAt: r.createdAt,
  };
}

/**
 * Adapter Postgres da `ApprovalPort` (HITL granular — 5b). O upsert das pendentes é
 * ATÔMICO via o índice único parcial `approvals_pending_uq`
 * (`(agent_id, entity_level, entity_id, action_type) WHERE status='pending'`) — evita
 * o TOCTOU de find-then-update sob runs concorrentes.
 */
export function createPostgresApprovals(db: Database): ApprovalPort {
  return {
    async upsertPending(input: UpsertPendingInput): Promise<Approval> {
      const { action } = input;
      const [row] = await db
        .insert(approvals)
        .values({
          orgId: input.orgId,
          agentId: input.agentId,
          runId: input.runId,
          status: "pending",
          entityLevel: action.target.level,
          entityId: action.target.id,
          actionType: action.type,
          action,
          expiresAt: input.expiresAt,
        })
        .onConflictDoUpdate({
          target: [approvals.agentId, approvals.entityLevel, approvals.entityId, approvals.actionType],
          targetWhere: sql`status = 'pending'`,
          // proposta reincidente → renova params/motivo/prazo (mantém a atual).
          set: { action, runId: input.runId, expiresAt: input.expiresAt, updatedAt: new Date() },
        })
        .returning();
      return toApproval(row as Row);
    },

    async listPendingByOrg(orgId: OrgId): Promise<Approval[]> {
      const rows = await db
        .select()
        .from(approvals)
        .where(and(eq(approvals.orgId, orgId), eq(approvals.status, "pending")))
        .orderBy(approvals.createdAt);
      return rows.map(toApproval);
    },

    async listPendingByAgent(agentId: AgentId): Promise<Approval[]> {
      const rows = await db
        .select()
        .from(approvals)
        .where(and(eq(approvals.agentId, agentId), eq(approvals.status, "pending")))
        .orderBy(approvals.createdAt);
      return rows.map(toApproval);
    },

    async getById(id: ApprovalId): Promise<Approval | null> {
      const [row] = await db.select().from(approvals).where(eq(approvals.id, id)).limit(1);
      return row ? toApproval(row) : null;
    },

    async resolve(id: ApprovalId, input: ResolveApprovalInput): Promise<Approval> {
      const [row] = await db
        .update(approvals)
        .set({
          status: input.status,
          resolvedReason: input.resolvedReason ?? null,
          resolvedAt: new Date(),
        })
        .where(eq(approvals.id, id))
        .returning();
      return toApproval(row as Row);
    },

    async getPendingByContact(contactId: ContactId): Promise<Approval | null> {
      const [row] = await db
        .select()
        .from(approvals)
        .where(and(eq(approvals.contactId, contactId), eq(approvals.status, "pending")))
        .orderBy(approvals.createdAt)
        .limit(1);
      return row ? toApproval(row) : null;
    },

    async expireOverdue(now: Date): Promise<number> {
      const rows = await db
        .update(approvals)
        .set({ status: "expired", resolvedAt: now })
        .where(and(eq(approvals.status, "pending"), lt(approvals.expiresAt, now)))
        .returning({ id: approvals.id });
      return rows.length;
    },
  };
}
