import { z } from "zod";
import { actionType, entityLevel, riskLevel } from "@trafego/shared/schemas";

export const runStatus = z.enum([
  "pending",
  "running",
  "succeeded",
  "failed",
  "waiting_approval",
  "partial",
]);

export const runSummary = z.object({
  id: z.string(),
  trigger: z.enum(["cron", "on_demand", "conversation"]),
  status: runStatus,
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

// ─── 3a: disparo on-demand + resultado (run + recomendações) ─────────────
export const triggerRunOutput = z.object({
  runId: z.string(),
  status: runStatus,
});
export type TriggerRunOutput = z.infer<typeof triggerRunOutput>;

/** Ação proposta (só para exibição no site — aplicação = Fatia 5). */
export const proposedActionOutput = z.object({
  type: actionType,
  target: z.object({ level: entityLevel, id: z.string() }),
  params: z.record(z.unknown()),
});

export const recommendationOutput = z.object({
  id: z.string(),
  title: z.string(),
  rationale: z.string().nullable(),
  riskLevel,
  /** aplicabilidade da sugestão — em 3a nada é aplicável (aplicação = Fatia 5). */
  applicability: z.enum(["applicable", "not_yet_applicable"]),
  proposedAction: proposedActionOutput.nullable(),
});
export type RecommendationOutput = z.infer<typeof recommendationOutput>;

export const runOutput = z.object({
  id: z.string(),
  status: runStatus,
  summary: z.string().nullable(),
  partial: z.boolean(),
  costUsd: z.number().nullable(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
});
export type RunOutput = z.infer<typeof runOutput>;

export const latestRunOutput = z.object({
  run: runOutput.nullable(),
  recommendations: z.array(recommendationOutput),
});
export type LatestRunOutput = z.infer<typeof latestRunOutput>;
