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
  /** rótulo do CPA derivado da conversão de negócio ("Custo por venda|conversa|lead|…"
   *  ou genérico "Custo por resultado") — projetado pela API; corrige o "venda" hardcoded. */
  cpaLabel: z.string().optional(),
  delta: deltaSchema,
});
export type LiveKpis = z.infer<typeof liveKpis>;

/** KPIs ao vivo de UMA conta + frescura (as-of) + janela. */
export const liveMetricsOutput = z.object({
  currency: z.string().nullable(),
  /** ISO da última vez que sincronizamos (max updated_at); null = nunca. */
  asOf: z.string().nullable(),
  /** dado passou do limite de frescura (server-side; evita threshold duplicado no web). */
  stale: z.boolean(),
  window: z.object({ since: z.string(), until: z.string() }),
  /** null = conta sem atividade na janela. */
  totals: liveKpis.nullable(),
});
export type LiveMetricsOutput = z.infer<typeof liveMetricsOutput>;

/** Resposta do "atualizar agora" (força sync-only, sem LLM). */
export const refreshDataOutput = z.object({ enqueued: z.boolean() });
export type RefreshDataOutput = z.infer<typeof refreshDataOutput>;

/** Motivos de uma conta pedir atenção (ordem de severidade na UI). */
export const attentionReason = z.enum(["token_invalid", "no_recent_run", "bad_grade", "pending"]);

/** Card de decisão por conta (panorama + faixa de atenção). */
export const panoramaCard = z.object({
  accountId: z.string(),
  accountName: z.string(),
  currency: z.string().nullable(),
  agentPaused: z.boolean(),
  tokenStatus: z.string(),
  /** grade da ÚLTIMA análise (datada) — null se nunca analisada. */
  grade: z.string().nullable(),
  gradeAsOf: z.string().nullable(),
  /** conta parada (activity_state=dormant) — o agente vigia o retorno (backoff). */
  dormant: z.boolean(),
  /** KPIs AO VIVO (insights_snapshots) — null se sem atividade. */
  live: liveKpis.nullable(),
  asOf: z.string().nullable(),
  /** dado ao vivo passou do limite de frescura (server-side). */
  stale: z.boolean(),
  pendingCount: z.number(),
  reasons: z.array(attentionReason),
});
export type PanoramaCard = z.infer<typeof panoramaCard>;

/** Evento compacto do feed de atividade cross-conta (inclui ações por chat). */
export const activityEvent = z.object({
  id: z.string(),
  accountId: z.string(),
  accountName: z.string(),
  type: z.enum(["action_applied", "action_rolled_back"]),
  toolKey: z.string(),
  entityName: z.string().nullable(),
  entityLevel: z.string().nullable(),
  at: z.string(),
  fromChat: z.boolean(),
});
export type ActivityEvent = z.infer<typeof activityEvent>;

/** Lista rica de contas (panorama completo) — tela Contas (roster informativo). */
export const panoramaListOutput = z.object({ accounts: z.array(panoramaCard) });
export type PanoramaListOutput = z.infer<typeof panoramaListOutput>;

/** Desperdício de UMA conta (gasto queimado na última análise). */
export const wasteAccount = z.object({
  accountId: z.string(),
  accountName: z.string(),
  /** Σ gasto dos zumbis na última análise finalizada. */
  wastedSpend: z.number(),
  /** moeda da conta (ISO) — nunca somar contas de moedas diferentes. */
  currency: z.string().nullable(),
});
export type WasteAccount = z.infer<typeof wasteAccount>;

/** Total de desperdício de UMA moeda (agrupamento — sem conversão de câmbio). */
export const wasteByCurrency = z.object({
  currency: z.string().nullable(),
  totalWasted: z.number(),
  accountCount: z.number(),
});
export type WasteByCurrency = z.infer<typeof wasteByCurrency>;

/** Desperdício cross-conta (§Bloco 2): totais POR MOEDA + contas que mais desperdiçam. */
export const wasteSummary = z.object({
  /** totais agrupados por moeda (multi-moeda: nunca soma moedas diferentes), maior primeiro. */
  byCurrency: z.array(wasteByCurrency),
  /** só contas com desperdício (> 0), maior primeiro. */
  accounts: z.array(wasteAccount),
});
export type WasteSummary = z.infer<typeof wasteSummary>;

/** Painel gerencial cross-conta (6a): widgets de decisão + desperdício (§Bloco 2). */
export const dashboardOutput = z.object({
  /** total de ações aguardando OK (cross-conta). */
  pendingCount: z.number(),
  /** faixa de triagem = contas com ≥1 motivo (subconjunto do panorama). */
  attention: z.array(panoramaCard),
  recentActivity: z.array(activityEvent),
  panorama: z.array(panoramaCard),
  /** desperdício cross-conta (§Bloco 2) — total + quem mais queima. */
  waste: wasteSummary,
});
export type DashboardOutput = z.infer<typeof dashboardOutput>;
