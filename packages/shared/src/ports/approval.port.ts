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
} from "../types/index.js";

export type ApprovalStatus = "pending" | "approved" | "rejected" | "expired" | "blocked";

/** Campos comuns a toda aprovação (ação ou rascunho). */
interface ApprovalBase {
  readonly id: ApprovalId;
  readonly orgId: OrgId;
  readonly agentId: AgentId;
  readonly runId: RunId | null;
  readonly contactId: ContactId | null;
  readonly status: ApprovalStatus;
  readonly resolvedReason: string | null;
  readonly expiresAt: Date;
  readonly createdAt: Date;
}

/**
 * Aprovação **granular** de UMA ação de otimização (HITL, 5b). Fonte da verdade das
 * pendentes de ação. Upsert por `(agentId, entityLevel, entityId, actionType)`; lote do
 * run por `runId`. `contactId`/`runId` nullable (site = sessão sem contato; run podável).
 */
export interface Approval extends ApprovalBase {
  readonly kind: "action";
  readonly entityLevel: EntityLevel;
  readonly entityId: string;
  readonly actionType: ActionType;
  readonly action: Action;
}

/**
 * Aprovação de um RASCUNHO de campanha (Fatia 7 — gasto novo). A proposta vive em
 * `campaign_drafts` (via `draftId`); ao aprovar, o apply-service dispara a saga de criação.
 */
export interface DraftApproval extends ApprovalBase {
  readonly kind: "draft";
  readonly draftId: DraftId;
}

/** União discriminada por `kind` — a caixa de entrada mistura ações e rascunhos. */
export type PendingApproval = Approval | DraftApproval;

/** Entrada do upsert de AÇÃO — a chave (agente+entidade+tipo) deriva de `action`. */
export interface UpsertPendingInput {
  readonly orgId: OrgId;
  readonly agentId: AgentId;
  readonly runId: RunId | null;
  readonly action: Action;
  readonly expiresAt: Date;
}

/** Entrada da aprovação de RASCUNHO — aponta pro `campaign_drafts` já persistido. */
export interface UpsertDraftPendingInput {
  readonly orgId: OrgId;
  readonly agentId: AgentId;
  readonly runId: RunId | null;
  readonly contactId: ContactId | null;
  readonly draftId: DraftId;
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
  /** Cria uma pendente de RASCUNHO (Fatia 7). Unicidade = campaign_drafts (não upsert aqui). */
  upsertDraftPending(input: UpsertDraftPendingInput): Promise<DraftApproval>;
  /** Pendentes da org (caixa de entrada cross-conta) — ações + rascunhos. */
  listPendingByOrg(orgId: OrgId): Promise<PendingApproval[]>;
  /** Pendentes de um agente (mini-surface da conta) — ações + rascunhos. */
  listPendingByAgent(agentId: AgentId): Promise<PendingApproval[]>;
  /** Uma aprovação por id (apply-service / ownership). */
  getById(id: ApprovalId): Promise<PendingApproval | null>;
  /** Resolve UMA aprovação (approved/rejected/blocked + motivo). */
  resolve(id: ApprovalId, input: ResolveApprovalInput): Promise<PendingApproval>;
  /** Pendente por contato (corte 2 — aprovação conversacional). */
  getPendingByContact(contactId: ContactId): Promise<PendingApproval | null>;
  /** Expira as pendentes vencidas (job periódico). Retorna quantas expiraram. */
  expireOverdue(now: Date): Promise<number>;
}
