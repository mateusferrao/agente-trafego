import { z } from "zod";

/** Delta vs baseline (fração por métrica) — setas de tendência na UI. */
const deltaSchema = z.record(z.string(), z.number());

/** KPIs da conta AO VIVO (6a): computados do insights_snapshots (sem LLM). */
export const liveKpis = z.object({
  spend: z.number(),
  impressions: z.number(),
  clicks: z.number(),
  ctr: z.number(),
  cpc: z.number().optional(),
  cpm: z.number().optional(),
  cpa: z.number().optional(),
  roas: z.number().optional(),
  delta: deltaSchema,
});
export type LiveKpis = z.infer<typeof liveKpis>;

/** KPIs ao vivo de UMA conta + frescura (as-of) + janela. */
export const liveMetricsOutput = z.object({
  currency: z.string().nullable(),
  /** ISO da última vez que sincronizamos (max updated_at); null = nunca. */
  asOf: z.string().nullable(),
  window: z.object({ since: z.string(), until: z.string() }),
  /** null = conta sem atividade na janela. */
  totals: liveKpis.nullable(),
});
export type LiveMetricsOutput = z.infer<typeof liveMetricsOutput>;

/** Resposta do "atualizar agora" (força sync-only, sem LLM). */
export const refreshDataOutput = z.object({ enqueued: z.boolean() });
export type RefreshDataOutput = z.infer<typeof refreshDataOutput>;
