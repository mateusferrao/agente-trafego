import type {
  Action,
  ActionType,
  AgentId,
  ApprovalId,
  ContactId,
  EntityLevel,
  OrgId,
  RunId,
} from "../types/index.js";

export type ApprovalStatus = "pending" | "approved" | "rejected" | "expired" | "blocked";

/**
 * Aprovação **granular**: 1 ação pendente de OK humano (HITL, 5b). A fonte da verdade
 * das pendentes. O upsert por `(agentId, entityLevel, entityId, actionType)` mantém a
 * proposta atual; o "lote do run" sai filtrando por `runId`. `contactId`/`runId` nullable
 * (aprovação via site = sessão logada, sem contato WhatsApp; run pode ser podado).
 */
export interface Approval {
  readonly id: ApprovalId;
  readonly orgId: OrgId;
  readonly agentId: AgentId;
  readonly runId: RunId | null;
  readonly contactId: ContactId | null;
  readonly status: ApprovalStatus;
  readonly entityLevel: EntityLevel;
  readonly entityId: string;
  readonly actionType: ActionType;
  readonly action: Action;
  readonly resolvedReason: string | null;
  readonly expiresAt: Date;
  readonly createdAt: Date;
}

/** Entrada do upsert — a chave (agente+entidade+tipo) deriva de `action`. */
export interface UpsertPendingInput {
  readonly orgId: OrgId;
  readonly agentId: AgentId;
  readonly runId: RunId | null;
  readonly action: Action;
  readonly expiresAt: Date;
}

/** Resolução de UMA aprovação (por-ação, corte 1). Batch conversacional = corte 2. */
export interface ResolveApprovalInput {
  readonly status: "approved" | "rejected" | "blocked";
  readonly resolvedReason?: string;
}

/**
 * HITL durável (approval + re-check fresco — sem checkpointer; §Fatia 5b). Grafo A
 * faz `upsertPending`; a resolução pelo site dispara o apply-service (worker), que
 * relê o estado fresco e aplica. Aprovação conversacional (WhatsApp) = corte 2.
 */
export interface ApprovalPort {
  /** Cria ou atualiza (renova) a pendente da chave (agente+entidade+tipo de ação). */
  upsertPending(input: UpsertPendingInput): Promise<Approval>;
  /** Pendentes da org (caixa de entrada cross-conta). */
  listPendingByOrg(orgId: OrgId): Promise<Approval[]>;
  /** Pendentes de um agente (mini-surface da conta). */
  listPendingByAgent(agentId: AgentId): Promise<Approval[]>;
  /** Uma aprovação por id (apply-service / ownership). */
  getById(id: ApprovalId): Promise<Approval | null>;
  /** Resolve UMA aprovação (approved/rejected/blocked + motivo). */
  resolve(id: ApprovalId, input: ResolveApprovalInput): Promise<Approval>;
  /** Pendente por contato (corte 2 — aprovação conversacional). */
  getPendingByContact(contactId: ContactId): Promise<Approval | null>;
  /** Expira as pendentes vencidas (job periódico). Retorna quantas expiraram. */
  expireOverdue(now: Date): Promise<number>;
}
