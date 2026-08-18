import { z } from "zod";

export const betaAccessOutput = z.object({
  status: z.enum(["pending", "granted", "denied"]),
});
export type BetaAccessOutput = z.infer<typeof betaAccessOutput>;

export const usageSummaryOutput = z.object({
  orgId: z.string(),
  period: z.string(), // "YYYY-MM"
  totalCostUsd: z.number(),
  byType: z.record(z.number()),
});
export type UsageSummaryOutput = z.infer<typeof usageSummaryOutput>;
