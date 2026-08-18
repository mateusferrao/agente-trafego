import { z } from "zod";

export const approvalOutput = z.object({
  id: z.string(),
  runId: z.string(),
  status: z.enum(["pending", "approved", "rejected", "expired"]),
  expiresAt: z.string(),
});
export type ApprovalOutput = z.infer<typeof approvalOutput>;

// Resolução via UI (fallback do fluxo conversacional no WhatsApp).
export const resolveApprovalInput = z.object({
  approvedActionIds: z.array(z.string()).default([]),
  rejectedActionIds: z.array(z.string()).default([]),
});
export type ResolveApprovalInput = z.infer<typeof resolveApprovalInput>;
