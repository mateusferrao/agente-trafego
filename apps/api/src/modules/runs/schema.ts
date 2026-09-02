import { z } from "zod";
import { actionType, conversionGoalSchema, entityLevel, recommendationKindSchema, riskLevel, scorecardGrade, scorecardSchema } from "@trafego/shared/schemas";

export const runStatus = z.enum([
  "pending",
  "running",
  "succeeded",
  "failed",
  "waiting_approval",
  "partial",
]);

export const runTrigger = z.enum(["cron", "on_demand", "conversation", "signal", "onboarding"]);

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
  /** Orçamento ATUAL da entidade (unidade MAIOR, ex reais) na proposta — só `adjust_budget`
   *  com atual conhecido; o editor inline mostra "atual → proposto". Null nos demais casos. */
  currentBudgetMajor: z.number().nullable(),
  /** Orçamento PROPOSTO resultante (unidade MAIOR) — projeção p/ exibição (pré-clamp). Null
   *  quando não dá pra projetar ou a ação não é de orçamento. */
  targetBudgetMajor: z.number().nullable(),
});

export const recommendationOutput = z.object({
  id: z.string(),
  title: z.string(),
  rationale: z.string().nullable(),
  /** formato (S2): platform_action (com ação) | human_direction | insight. */
  kind: recommendationKindSchema,
  riskLevel,
  /**
   * Aplicabilidade REAL (B): "applicable" = há aprovação/rascunho pendente pra agir agora;
   * "applied" = já aplicada; "dismissed"/"expired" = resolvida; "not_applicable" = direção/insight
   * (sem ação executável). O card decide o CTA por aqui.
   */
  applicability: z.enum(["applicable", "applied", "dismissed", "expired", "not_applicable"]),
  proposedAction: proposedActionOutput.nullable(),
  /** capacidade do catálogo proposta — só em platform_action. */
  toolKey: z.string().nullable(),
  /** rascunho de campanha ligado (criação) — abre o editor no site. */
  draftId: z.string().nullable(),
  /** aprovação acionável ligada (ação OU rascunho/ativação pendente) — aprovar/rejeitar/editar. */
  approvalId: z.string().nullable(),
  approvalKind: z.enum(["action", "draft", "activation"]).nullable(),
  /** voto do dono (👍/👎), quando houver — o card do site reflete o estado. */
  vote: z.enum(["up", "down"]).nullable(),
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
  /** conversão de negócio do CPA da conta (persistida no snapshot) — deriva o rótulo. */
  conversionGoal: conversionGoalSchema.optional(),
  /** rótulo do CPA (projetado pela API a partir de `conversionGoal`): "Custo por venda"
   *  / "Custo por lead" / "Custo por resultado" (genérico). Não persistido. */
  cpaLabel: z.string().optional(),
});

/** Funil de messaging agregado (contagens + taxas) — só quando há dado. */
export const runFunnel = z.object({
  counts: z.record(funnelStage, z.number()),
  replyRate: z.number().optional(),
  depthRate: z.number().optional(),
});

/** Base de medição do custo por resultado (§Bloco 2) — espelha `ConversionBasis`. */
export const conversionBasis = z.enum(["target", "proxy", "none"]);

/** Um item do Pareto de gasto × resultado (§Bloco 2). */
export const wasteParetoItem = z.object({
  id: z.string(),
  name: z.string(),
  spend: z.number(),
  /** % do gasto do grupo (mesma base de conversão). */
  spendPct: z.number(),
  /** resultado do grupo (vendas/conversas/cliques conforme a base), quando derivável. */
  result: z.number().optional(),
  resultPct: z.number().optional(),
});

/** Concentração 80/20 dentro de um grupo de mesma base de conversão (§Bloco 2). */
export const wastePareto = z.object({
  basis: conversionBasis,
  groupSpend: z.number(),
  items: z.array(wasteParetoItem),
  /** má alocação: gasto alto e resultado desproporcionalmente baixo. */
  misallocated: z.array(wasteParetoItem),
});

/** Um zumbi: campanha com gasto relevante e zero sinal de vida. */
export const wasteZombie = z.object({ id: z.string(), name: z.string(), spend: z.number() });

/** Quantificação de desperdício (§Bloco 2): quanto se queima + onde o gasto está mal alocado. */
export const wasteReport = z.object({
  totalSpend: z.number(),
  wastedSpend: z.number(),
  wastedPct: z.number(),
  zombies: z.array(wasteZombie),
  pareto: wastePareto.optional(),
});

/** Saúde da medição de conversão (§Bloco 2) — presente só quando suspeita. */
export const trackingHealth = z.object({
  suspect: z.boolean(),
  /** conversas (conversation_started) agregadas da conta. */
  funnelStarted: z.number(),
  /** conversões de negócio rastreadas agregadas (meta do agente). */
  trackedConversions: z.number(),
  /** razão conversas / max(conversões,1) — quanto maior, mais suspeita a medição. */
  ratio: z.number(),
});

/** Snapshot de métricas do run (KPIs sempre; funil/scorecard/waste/tracking quando houver). */
export const runMetrics = z.object({
  kpis: runKpis,
  funnel: runFunnel.optional(),
  scorecard: scorecardSchema.optional(),
  /** desperdício + concentração 80/20 (§Bloco 2) — o "money shot" da auditoria. */
  waste: wasteReport.optional(),
  /** saúde da medição de conversão (§Bloco 2) — ressalva antes de julgar por custo. */
  trackingHealth: trackingHealth.optional(),
});
export type RunMetrics = z.infer<typeof runMetrics>;

export const runOutput = z.object({
  id: z.string(),
  status: runStatus,
  summary: z.string().nullable(),
  /** narrativa voiceada (redator, aplica a postura) — a "fala" do agente; o site
   *  exibe no topo no lugar do summary neutro (fallback ao summary se null). */
  narrative: z.string().nullable(),
  partial: z.boolean(),
  /** Nota proporcional da degradação (null quando não parcial) — a UI exibe direto. */
  partialNote: z.string().nullable(),
  /** Gravidade: none | soft (métricas ok) | hard (dado incompleto) — define o tom. */
  partialSeverity: z.enum(["none", "soft", "hard"]),
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

// ─── recorte por campanha (análise por-campanha) ─────────────────────────
/** Métricas curadas de uma campanha no cartão (só o que importa pro gestor). */
export const campaignAnalysisMetrics = z.object({
  spend: z.number(),
  ctr: z.number().optional(),
  cpa: z.number().optional(),
  roas: z.number().optional(),
});

/** Evidência numérica de um achado (métrica que o prova). */
export const findingMetricRef = z.object({ label: z.string(), value: z.string() });

/** Achado principal da campanha — o maior gargalo, agora COM evidência (detail + números). */
export const campaignTopFinding = z.object({
  title: z.string(),
  severity: z.enum(["info", "warning", "critical"]),
  detail: z.string().nullable().optional(),
  metricRefs: z.array(findingMetricRef).optional(),
});

/** Orçamento da campanha (S8 — fecha o bug do site não mostrar orçamento por campanha,
 *  mesmo caso original do chat, S1). Diário OU vitalício (a Meta usa um ou outro). */
export const campaignBudgetOutput = z.object({
  dailyMajor: z.number().optional(),
  lifetimeMajor: z.number().optional(),
  lifetimeRemainingMajor: z.number().optional(),
});

/** Uma campanha analisada: métrica + resumo + gargalo + flags + estado silenciado. */
export const campaignAnalysisOutput = z.object({
  externalId: z.string(),
  name: z.string().nullable(),
  metrics: campaignAnalysisMetrics,
  summary: z.string().nullable(),
  topFinding: campaignTopFinding.nullable(),
  flags: z.array(z.string()),
  /** tier de desempenho (6c): winner|performer|underperformer|zombie. */
  tier: z.enum(["winner", "performer", "underperformer", "zombie"]).nullable(),
  /** estágio de público dominante (§Bloco 2) — congelado no run; null na visão ao vivo. */
  stage: z.enum(["prospecting", "remarketing", "unknown"]).nullable(),
  /** campanha silenciada pelo dono (opt-out da análise). */
  muted: z.boolean(),
  /** orçamento curado (S8); null = sem dado (conta não reanalisada desde que isso passou a ser coletado). */
  budget: campaignBudgetOutput.nullable(),
  /** true = sem folga pra gastar mais sem subir o orçamento; false = tem folga; null = sem dado. */
  atBudgetCeiling: z.boolean().nullable(),
  /** true = orçamento na PRÓPRIA campanha (CBO); false = por conjunto/adset (ABO); null = sem dado. */
  isCBO: z.boolean().nullable(),
  /** sincronização (achado real): presente = a Meta não lista mais como ativa desde esta data
   *  (ISO) — o resto dos campos é da ÚLTIMA vez que ela esteve ativa. null = ainda ativa. */
  deactivatedSince: z.string().nullable(),
  /** sincronização (achado real, gap irmão do `deactivatedSince`): true = campanha ATIVA na Meta
   *  agora mas ainda sem NENHUMA análise (criada depois do último run) — todos os outros campos
   *  vêm vazios/null, nunca inventados. false = campanha já tem análise (fluxo normal). */
  noDataYet: z.boolean(),
});
export type CampaignAnalysisOutput = z.infer<typeof campaignAnalysisOutput>;

export const campaignAnalysesOutput = z.object({
  campaigns: z.array(campaignAnalysisOutput),
});
export type CampaignAnalysesOutput = z.infer<typeof campaignAnalysesOutput>;

// ─── 6a: histórico de análises (lista + detalhe por run) ─────────────────
/** Item da lista de análises anteriores (o essencial p/ a linha + filtros). */
export const runListItem = z.object({
  id: z.string(),
  createdAt: z.string(),
  trigger: runTrigger,
  status: runStatus,
  partial: z.boolean(),
  /** nota do scorecard (null quando o run não produziu — ex: conta parada/falha). */
  grade: scorecardGrade.nullable(),
  /** headline do scorecard OU o resumo curto (null quando não há). */
  headline: z.string().nullable(),
  recommendationCount: z.number(),
  costUsd: z.number().nullable(),
});
export type RunListItem = z.infer<typeof runListItem>;

export const runListOutput = z.object({
  items: z.array(runListItem),
  /** há mais páginas além desta (paginação por limit/offset). */
  hasMore: z.boolean(),
});
export type RunListOutput = z.infer<typeof runListOutput>;

/** Detalhe de UM run (histórico): run + recomendações + recorte por campanha do snapshot. */
export const runDetailOutput = z.object({
  run: runOutput.nullable(),
  recommendations: z.array(recommendationOutput),
  campaigns: z.array(campaignAnalysisOutput),
  /** é o run mais recente da conta? (o site avisa quando NÃO é). */
  isLatest: z.boolean(),
});
export type RunDetailOutput = z.infer<typeof runDetailOutput>;
