import { z } from "zod";
import { actionType } from "@trafego/shared/schemas";

const approvalStatusOutput = z.enum(["pending", "approved", "rejected", "expired", "blocked"]);

/** Uma aprovação pendente (granular, 5b) — caixa de entrada cross-conta. */
export const approvalOutput = z.object({
  id: z.string(),
  accountId: z.string(),
  accountName: z.string(),
  entityLevel: z.string(),
  entityId: z.string(),
  entityName: z.string().nullable(),
  type: actionType,
  reason: z.string(),
  status: approvalStatusOutput,
  /** ISO — prazo de resposta (expira em 24h e some da lista). */
  expiresAt: z.string().nullable(),
  /** Moeda da conta (ISO, ex "BRL"/"USD") — formata os valores no card. Null = desconhecida. */
  currency: z.string().nullable(),
  /** Orçamento ATUAL da entidade (unidade MAIOR, ex reais) na proposta — só `adjust_budget`
   *  com atual conhecido; o card mostra "atual → proposto". Null nos demais casos. */
  currentBudgetMajor: z.number().nullable(),
  /** Orçamento PROPOSTO resultante (unidade MAIOR) — projeção p/ exibição (pré-clamp). Null
   *  quando não dá pra projetar (sem atual, sem pct/valor) ou ação não é de orçamento. */
  targetBudgetMajor: z.number().nullable(),
});
export type ApprovalOutput = z.infer<typeof approvalOutput>;

export const approvalsListOutput = z.array(approvalOutput);

/** Resolução por-ação (corte 1). Batch conversacional (WhatsApp) = corte 2. */
export const resolveApprovalInput = z.object({
  decision: z.enum(["approve", "reject"]),
});
export type ResolveApprovalInput = z.infer<typeof resolveApprovalInput>;

export const resolveApprovalOutput = z.object({
  id: z.string(),
  status: approvalStatusOutput,
});
export type ResolveApprovalOutput = z.infer<typeof resolveApprovalOutput>;

/**
 * Editar o VALOR de uma ação `adjust_budget` pendente ANTES de aprovar (C, v1). `pct`
 * (increase/decrease em %) OU `budgetReais` (valor/dia absoluto, mode "set"). Só o valor —
 * pausar/retomar/status não têm número. O clamp do blast-radius é rede do apply.
 */
export const editApprovalActionInput = z
  .object({
    mode: z.enum(["increase", "decrease", "set"]),
    pct: z.number().positive().optional(),
    budgetReais: z.number().positive().optional(),
  })
  .refine((v) => (v.mode === "set" ? v.budgetReais !== undefined : v.pct !== undefined), {
    message: "informe pct (increase/decrease) ou budgetReais (set)",
  });
export type EditApprovalActionInput = z.infer<typeof editApprovalActionInput>;

/**
 * Uma ação aplicada ainda ACIONÁVEL quanto a reverter, cross-conta (dentro do TTL —
 * `undoable` ou `revertBlocked`, nunca as duas false). O revert em si usa a rota
 * por-conta (`POST /accounts/:accountId/agent/actions/:toolCallId/undo`).
 */
export const revertibleActionOutput = z.object({
  toolCallId: z.string(),
  accountId: z.string(),
  accountName: z.string(),
  // `type` = toolKey cru — z.string() de propósito (mesmo motivo do appliedActionOutput).
  type: z.string(),
  targetLevel: z.string(),
  targetId: z.string(),
  targetName: z.string().nullable(),
  undoable: z.boolean(),
  revertBlocked: z.boolean(),
  revertBlockedReason: z.string().nullable(),
});
export type RevertibleActionOutput = z.infer<typeof revertibleActionOutput>;
