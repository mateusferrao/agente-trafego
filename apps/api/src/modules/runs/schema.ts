import { z } from "zod";
import { actionType, entityLevel, riskLevel, scorecardSchema } from "@trafego/shared/schemas";

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

// ─── 3a-2: métricas congeladas do run (KPIs + funil + scorecard) p/ o site ──
export const funnelStage = z.enum([
  "conversation_started",
  "first_reply",
  "depth_2",
  "depth_3",
  "depth_5",
  "replied",
]);

/** KPIs da conta no run (só o que houve; conversão/receita podem faltar). */
export const runKpis = z.object({
  spend: z.number(),
  impressions: z.number(),
  clicks: z.number(),
  ctr: z.number(),
  cpa: z.number().optional(),
  roas: z.number().optional(),
});

/** Funil de messaging agregado (contagens + taxas) — só quando há dado. */
export const runFunnel = z.object({
  counts: z.record(funnelStage, z.number()),
  replyRate: z.number().optional(),
  depthRate: z.number().optional(),
});

/** Snapshot de métricas do run (KPIs sempre; funil/scorecard quando houver). */
export const runMetrics = z.object({
  kpis: runKpis,
  funnel: runFunnel.optional(),
  scorecard: scorecardSchema.optional(),
});
export type RunMetrics = z.infer<typeof runMetrics>;

export const runOutput = z.object({
  id: z.string(),
  status: runStatus,
  summary: z.string().nullable(),
  partial: z.boolean(),
  costUsd: z.number().nullable(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
  /** KPIs + funil + scorecard congelados (null em conta parada / run sem métricas). */
  metrics: runMetrics.nullable(),
});
export type RunOutput = z.infer<typeof runOutput>;

export const latestRunOutput = z.object({
  run: runOutput.nullable(),
  recommendations: z.array(recommendationOutput),
});
export type LatestRunOutput = z.infer<typeof latestRunOutput>;
