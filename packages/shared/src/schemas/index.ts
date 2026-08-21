import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { CONVERSION_GOALS } from "../types/index.js";

// Fonte da verdade dos contratos (zod → OpenAPI → kubb). Expandir por feature.

export const entityLevel = z.enum(["account", "campaign", "adset", "ad"]);
/** Taxonomia neutra de conversão (deriva da mesma tupla que o tipo — fonte única). */
export const conversionGoalSchema = z.enum(CONVERSION_GOALS);
export const actionType = z.enum([
  "pause_entity",
  "resume_entity",
  "adjust_budget",
  "set_status",
]);
export const riskLevel = z.enum(["low", "medium", "high"]);
export const actionSource = z.enum(["playbook", "llm"]);

export const actionSchema = z.object({
  id: z.string(),
  type: actionType,
  target: z.object({ level: entityLevel, id: z.string() }),
  params: z.record(z.unknown()),
  source: actionSource,
  riskLevel,
  reason: z.string(),
  confidence: z.number().min(0).max(1).optional(),
  ruleId: z.string().optional(),
});

export const playbookRuleSchema = z.object({
  id: z.string(),
  enabled: z.boolean(),
  priority: z.number().int(),
  scope: z.enum(["campaign", "adset", "ad"]),
  when: z.object({
    metric: z.string(),
    op: z.enum([">", "<", ">=", "<=", "=="]),
    value: z.number(),
    window: z.enum(["3d", "7d", "14d"]),
    minSpend: z.number().optional(),
  }),
  then: z.object({ type: actionType }).passthrough(),
});

export const guardrailConfigSchema = z.object({
  maxBudgetChangePct: z.number().min(0).max(100),
  maxEntitiesPerDay: z.number().int().min(0),
  allowedActions: z.array(actionType),
  dryRun: z.boolean(),
  killSwitch: z.boolean(),
  llmCostCapUsd: z.number().min(0).optional(),
});

export const autonomyLevel = z.enum(["notify", "suggest", "act_safe", "act_full"]);
export const autonomyPolicySchema = z.object({
  bySource: z.object({ playbook: autonomyLevel, llm: autonomyLevel }),
  /** kill-switch da auto-config por chat (S2.3) — ausente/true = ON; false = OFF. */
  autoConfigViaChat: z.boolean().optional(),
});

// ─── Cadência (Fatia 4 corte 2) ──────────────────────────────────────────
// `CadenceSpec` = FONTE ÚNICA do ritmo da análise automática; o cron 5-campos é
// SEMPRE derivado por `cadenceToCron` (core). Presets hora-granulares (minuto=0)
// p/ o cron ser sempre expressável; `raw` é o escape do avançado. Shape extensível
// (novas variantes = mais membros no union, sem tocar no que existe).
const cadenceHour = z.number().int().min(0).max(23);
/** Dia da semana no padrão cron dow: 0=domingo … 6=sábado. */
const cadenceWeekday = z.number().int().min(0).max(6);
export const cadenceSpecSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("daily"), hour: cadenceHour }),
  z.object({ kind: z.literal("twice_daily"), hours: z.tuple([cadenceHour, cadenceHour]) }),
  z.object({ kind: z.literal("weekly"), weekday: cadenceWeekday, hour: cadenceHour }),
  z.object({ kind: z.literal("raw"), cron: z.string().min(1) }),
]);
export type CadenceSpec = z.infer<typeof cadenceSpecSchema>;

// ─── Saída estruturada da análise (LLM) ──────────────────────────────────
// Contrato do que o LLM devolve em `llm_analyze` (structured output). Sem
// `.optional()` — usamos `.nullable()`/arrays vazios p/ o strict json_schema do
// OpenRouter (que exige todas as chaves em `required`).

export const findingSeverity = z.enum(["info", "warning", "critical"]);
export const recommendationPriority = z.enum(["high", "medium", "low"]);

/** Tipo de ação sugerida pelo LLM — superconjunto: alguns viram Action tipada
 *  (pause/resume/budget), outros são só consultivos (revisar/investigar/manter). */
export const recommendationActionType = z.enum([
  "pause",
  "resume",
  "increase_budget",
  "decrease_budget",
  "review_creative",
  "review_audience",
  "investigate",
  "keep",
]);

/** Diagnóstico único da conta (adaptado do automato). `biggestLeak` aparado ao
 *  que medimos (sem `lucro`, que exige margem). Enum aberto p/ novos estágios. */
export const scorecardGrade = z.enum(["A", "B", "C", "D"]);
export const biggestLeak = z.enum(["consciencia", "engajamento", "conversao", "receita"]);
export const scorecardSchema = z.object({
  grade: scorecardGrade,
  headline: z.string(),
  biggestLeak,
});

export const analysisFindingSchema = z.object({
  id: z.string(),
  title: z.string(),
  detail: z.string(),
  severity: findingSeverity,
  metricRefs: z.array(z.object({ label: z.string(), value: z.union([z.number(), z.string()]) })),
});

export const analysisRecommendationSchema = z.object({
  id: z.string(),
  title: z.string(),
  rationale: z.string(),
  priority: recommendationPriority,
  actionType: recommendationActionType,
  targetEntity: z.object({ level: entityLevel, externalId: z.string() }).nullable(),
  budgetChangePct: z.number().nullable(),
});

export const analysisOutputSchema = z.object({
  scorecard: scorecardSchema,
  summary: z.string(),
  findings: z.array(analysisFindingSchema),
  recommendations: z.array(analysisRecommendationSchema),
});

/** Análise de UMA unidade (anúncio) no map-reduce (3b-2) — sem scorecard (é da conta). */
export const unitAnalysisSchema = z.object({
  summary: z.string(),
  findings: z.array(analysisFindingSchema),
  recommendations: z.array(analysisRecommendationSchema),
  flags: z.array(z.string()),
});
export type UnitAnalysis = z.infer<typeof unitAnalysisSchema>;

export type ScorecardGrade = z.infer<typeof scorecardGrade>;
export type BiggestLeak = z.infer<typeof biggestLeak>;
export type Scorecard = z.infer<typeof scorecardSchema>;
export type RecommendationActionType = z.infer<typeof recommendationActionType>;
export type AnalysisFinding = z.infer<typeof analysisFindingSchema>;
export type AnalysisRecommendation = z.infer<typeof analysisRecommendationSchema>;
export type AnalysisOutput = z.infer<typeof analysisOutputSchema>;

/** JSON Schema (strict) do output — passado no `response_format` do OpenRouter. */
export const ANALYSIS_OUTPUT_JSON_SCHEMA: Readonly<Record<string, unknown>> = zodToJsonSchema(
  analysisOutputSchema,
  { target: "openApi3", $refStrategy: "none" },
) as Record<string, unknown>;

/** Nome do schema (identifica o structured output p/ o provider). */
export const ANALYSIS_OUTPUT_SCHEMA_NAME = "account_analysis";

/** JSON Schema (strict) da análise por-unidade (map). */
export const UNIT_ANALYSIS_JSON_SCHEMA: Readonly<Record<string, unknown>> = zodToJsonSchema(
  unitAnalysisSchema,
  { target: "openApi3", $refStrategy: "none" },
) as Record<string, unknown>;
export const UNIT_ANALYSIS_SCHEMA_NAME = "unit_analysis";
