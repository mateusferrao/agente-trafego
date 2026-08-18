import { z } from "zod";

export const runSummary = z.object({
  id: z.string(),
  trigger: z.enum(["cron", "on_demand", "conversation"]),
  status: z.enum(["running", "succeeded", "failed", "waiting_approval"]),
  startedAt: z.string(),
  costUsd: z.number().nullable(),
});
export type RunSummary = z.infer<typeof runSummary>;

export const runStep = z.object({
  name: z.string(),
  status: z.enum(["pending", "running", "done", "error"]),
  at: z.string(),
});

export const runTimeline = runSummary.extend({
  steps: z.array(runStep),
});
export type RunTimeline = z.infer<typeof runTimeline>;
