import { z } from "zod";

// Status de acesso ao produto (mesmo enum durável de `access_grants.status`).
export const accessStatusOutput = z.object({
  status: z.enum(["pending", "active", "revoked"]),
});
export type AccessStatusOutput = z.infer<typeof accessStatusOutput>;

export const usageSummaryOutput = z.object({
  orgId: z.string(),
  period: z.string(), // "YYYY-MM"
  totalCostUsd: z.number(),
  byType: z.record(z.number()),
});
export type UsageSummaryOutput = z.infer<typeof usageSummaryOutput>;
