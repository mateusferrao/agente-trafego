import { z } from "zod";

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
