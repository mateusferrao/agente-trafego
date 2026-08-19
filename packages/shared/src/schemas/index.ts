import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

// Fonte da verdade dos contratos (zod → OpenAPI → kubb). Expandir por feature.

export const entityLevel = z.enum(["account", "campaign", "adset", "ad"]);
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
});

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
  summary: z.string(),
  findings: z.array(analysisFindingSchema),
  recommendations: z.array(analysisRecommendationSchema),
});

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
