import { and, desc, eq, inArray, lt, sql } from "drizzle-orm";
import { approvals, campaignDrafts, type Database } from "@trafego/db";
import type {
  ActivationApproval,
  Approval,
  ApprovalPort,
  DraftApproval,
  PendingApproval,
  ResolveApprovalInput,
  UpsertActivationPendingInput,
  UpsertDraftPendingInput,
  UpsertPendingInput,
} from "@trafego/shared/ports";
import type {
  Action,
  ActionType,
  AgentId,
  ApprovalId,
  ContactId,
  DraftId,
  EntityLevel,
  OrgId,
  RunId,
} from "@trafego/shared/types";

type Row = typeof approvals.$inferSelect;

/**
 * Linha do banco → contrato de domínio (union discriminada por `kind`, P0.1): rascunho/
 * ativação (Fatia 7) quando `draft_id` set — `kind` decide qual dos dois —, senão ação.
 * Ids reidratados p/ os tipos branded.
 */
function toPendingApproval(r: Row): PendingApproval {
  const base = {
    id: r.id as ApprovalId,
    orgId: r.orgId as OrgId,
    agentId: r.agentId as AgentId,
    runId: (r.runId ?? null) as RunId | null,
    contactId: (r.contactId ?? null) as ContactId | null,
    status: r.status,
    resolvedReason: r.resolvedReason ?? null,
    expiresAt: r.expiresAt ?? new Date(0),
    createdAt: r.createdAt,
  };
  if (r.draftId !== null) {
    return { ...base, kind: r.kind === "activation" ? "activation" : "draft", draftId: r.draftId as DraftId };
  }
  return {
    ...base,
    kind: "action",
    entityLevel: r.entityLevel as EntityLevel,
    entityId: r.entityId as string,
    actionType: r.actionType as ActionType,
    action: r.action as Action,
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
      return toPendingApproval(row as Row) as Approval;
    },

    async upsertDraftPending(input: UpsertDraftPendingInput): Promise<DraftApproval> {
      // Unicidade do rascunho vive em campaign_drafts (1 proposto/conta no proativo);
      // aqui só criamos a linha de aprovação apontando pro draft (sem upsert por entidade).
      const [row] = await db
        .insert(approvals)
        .values({
          orgId: input.orgId,
          agentId: input.agentId,
          runId: input.runId,
          contactId: input.contactId,
          status: "pending",
          kind: "draft",
          draftId: input.draftId,
          expiresAt: input.expiresAt,
        })
        .returning();
      return toPendingApproval(row as Row) as DraftApproval;
    },

    async upsertActivationPending(input: UpsertActivationPendingInput): Promise<ActivationApproval> {
      // Unicidade por `approvals_pending_draft_uq` (draft_id, kind) WHERE pending — no máx.
      // 1 ativação pendente por rascunho. `onConflictDoNothing` + re-select cobre retry/replay
      // da saga de criação (idempotente, mesmo padrão do dedup de criativo — P0.2).
      const inserted = await db
        .insert(approvals)
        .values({
          orgId: input.orgId,
          agentId: input.agentId,
          runId: input.runId,
          contactId: input.contactId,
          status: "pending",
          kind: "activation",
          draftId: input.draftId,
          expiresAt: input.expiresAt,
        })
        .onConflictDoNothing({ target: [approvals.draftId, approvals.kind], where: sql`status = 'pending' and draft_id is not null` })
        .returning();
      if (inserted[0]) return toPendingApproval(inserted[0] as Row) as ActivationApproval;
      const [existing] = await db
        .select()
        .from(approvals)
        .where(and(eq(approvals.draftId, input.draftId), eq(approvals.kind, "activation"), eq(approvals.status, "pending")))
        .limit(1);
      if (!existing) throw new Error("upsertActivationPending: conflito sem linha resolvível");
      return toPendingApproval(existing as Row) as ActivationApproval;
    },

    async listPendingByOrg(orgId: OrgId): Promise<PendingApproval[]> {
      const rows = await db
        .select()
        .from(approvals)
        .where(and(eq(approvals.orgId, orgId), eq(approvals.status, "pending")))
        .orderBy(desc(approvals.createdAt)); // mais novo primeiro — a pendência recém-criada no topo
      return rows.map(toPendingApproval);
    },

    async listPendingByAgent(agentId: AgentId): Promise<PendingApproval[]> {
      const rows = await db
        .select()
        .from(approvals)
        .where(and(eq(approvals.agentId, agentId), eq(approvals.status, "pending")))
        .orderBy(desc(approvals.createdAt)); // mais novo primeiro
      return rows.map(toPendingApproval);
    },

    async getById(id: ApprovalId): Promise<PendingApproval | null> {
      const [row] = await db.select().from(approvals).where(eq(approvals.id, id)).limit(1);
      return row ? toPendingApproval(row) : null;
    },

    async resolve(id: ApprovalId, input: ResolveApprovalInput): Promise<PendingApproval> {
      const [row] = await db
        .update(approvals)
        .set({
          status: input.status,
          resolvedReason: input.resolvedReason ?? null,
          resolvedAt: new Date(),
        })
        .where(eq(approvals.id, id))
        .returning();
      // Rascunho recusado (kind "draft", NÃO "activation" — nessa a campanha já existe): tira
      // o draft de "proposed" p/ os pickers por-status (intake de mídia / troca de criativo) não
      // oferecerem mexer num rascunho morto. `activation`/`approved` não passam por aqui.
      if (input.status === "rejected" && row?.kind === "draft" && row.draftId) {
        await revertOrphanedDrafts(db, [row.draftId]);
      }
      return toPendingApproval(row as Row);
    },

    async getPendingByContact(contactId: ContactId): Promise<PendingApproval | null> {
      const [row] = await db
        .select()
        .from(approvals)
        .where(and(eq(approvals.contactId, contactId), eq(approvals.status, "pending")))
        .orderBy(approvals.createdAt)
        .limit(1);
      return row ? toPendingApproval(row) : null;
    },

    async expireOverdue(now: Date): Promise<number> {
      const rows = await db
        .update(approvals)
        .set({ status: "expired", resolvedAt: now })
        .where(and(eq(approvals.status, "pending"), lt(approvals.expiresAt, now)))
        .returning({ id: approvals.id, kind: approvals.kind, draftId: approvals.draftId });
      // Mesmo cuidado do reject: rascunho que expirou some dos pickers por-status (só "draft").
      const orphanedDrafts = rows.filter((r) => r.kind === "draft" && r.draftId).map((r) => r.draftId as string);
      if (orphanedDrafts.length > 0) await revertOrphanedDrafts(db, orphanedDrafts);
      return rows.length;
    },
  };
}

/**
 * Sincroniza rascunhos cuja approval de CRIAÇÃO foi recusada/expirada: `proposed`/`failed`
 * → `reverted` (terminal), num único UPDATE. Fonte única p/ resolve + expireOverdue (§13
 * DRY) — evita que os pickers por `status='proposed'` (intake de mídia, troca de criativo)
 * ofereçam mexer num rascunho que não vai mais virar campanha.
 */
async function revertOrphanedDrafts(db: Database, draftIds: readonly string[]): Promise<void> {
  await db
    .update(campaignDrafts)
    .set({ status: "reverted" })
    .where(and(inArray(campaignDrafts.id, [...draftIds]), inArray(campaignDrafts.status, ["proposed", "failed"])));
}
