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
