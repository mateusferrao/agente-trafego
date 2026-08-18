import type { Action, ApprovalId, ContactId, RunId } from "../types/index.js";

export type ApprovalStatus = "pending" | "approved" | "rejected" | "expired";

export interface Approval {
  readonly id: ApprovalId;
  readonly runId: RunId;
  readonly contactId: ContactId;
  readonly status: ApprovalStatus;
  /** ações pendentes que a resposta conversacional vai resolver. */
  readonly actions: readonly Action[];
  readonly expiresAt: Date;
}

export interface ApprovalDecision {
  readonly approvedActionIds: readonly string[];
  readonly rejectedActionIds: readonly string[];
}

/**
 * HITL durável. Grafo A cria + interrupt(); resposta no WhatsApp resolve →
 * resume (novo job). Aprovação conversacional (sem código); eco+confirma
 * antes de escrever é regra de negócio na casca, não aqui.
 */
export interface ApprovalPort {
  create(input: Omit<Approval, "id" | "status">): Promise<Approval>;
  resolve(id: ApprovalId, decision: ApprovalDecision): Promise<Approval>;
  getPendingByContact(contactId: ContactId): Promise<Approval | null>;
  expireOverdue(now: Date): Promise<number>;
}
