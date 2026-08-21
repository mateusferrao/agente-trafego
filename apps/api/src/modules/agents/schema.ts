import { z } from "zod";
import {
  actionType,
  autonomyPolicySchema,
  cadenceSpecSchema,
  conversionGoalSchema,
  guardrailConfigSchema,
} from "@trafego/shared/schemas";
import { ANALYSIS_WINDOW_MIN_DAYS, ANALYSIS_WINDOW_MAX_DAYS } from "@trafego/shared";

// Fatia 4: meta + conversão + personalização + janela (corte 1) · identidade/voz +
// cadência + playbook (corte 2). Limites da janela = fonte única em @trafego/shared.

/** Teto de caracteres dos campos de texto livre (guarda prompt inchado). */
const TEXT_FIELD_MAX = 2000;
/** Teto do override de system_prompt (mais folgado — é o prompt inteiro do analista). */
const PROMPT_FIELD_MAX = 8000;
/** Teto de persona/tone (rótulos curtos de identidade). */
const IDENTITY_FIELD_MAX = 280;

/** Limiares de qualidade editáveis (6c) — override por-agente; vazio = padrão do sistema. */
export const qualityConfigInput = z.object({
  minConversions: z.number().int().positive().optional(),
  minClicks: z.number().int().positive().optional(),
  fatigueCtrDropPct: z.number().nonnegative().optional(),
  fatigueFrequency: z.number().positive().optional(),
  fatigueCostRisePct: z.number().nonnegative().optional(),
  zombieMinSpend: z.number().nonnegative().optional(),
  coldStartReference: z.boolean().optional(),
});
export type QualityConfigInput = z.infer<typeof qualityConfigInput>;

/** Defaults do sistema dos limiares de qualidade (env) — p/ a UI mostrar como placeholder real. */
export const qualityDefaultsOutput = z.object({
  minConversions: z.number(),
  minClicks: z.number(),
  fatigueCtrDropPct: z.number(),
  fatigueFrequency: z.number(),
  fatigueCostRisePct: z.number(),
  zombieMinSpend: z.number(),
  coldStartReference: z.boolean(),
});
export type QualityDefaultsOutput = z.infer<typeof qualityDefaultsOutput>;

/** "Opções avançadas" (6c): override por-agente de model_config. Tudo opcional (patch). */
export const modelConfigInput = z.object({
  model: z.string().optional(),
  unitModel: z.string().optional(),
  messageModel: z.string().optional(),
  visionModel: z.string().optional(),
  reviewEnabled: z.boolean().optional(),
  topN: z.number().int().positive().optional(),
  maxOutputTokens: z.number().int().positive().optional(),
  quality: qualityConfigInput.optional(),
});
export type ModelConfigInput = z.infer<typeof modelConfigInput>;

export const agentGoalsInput = z.object({
  targetCPA: z.number().positive().optional(),
  targetROAS: z.number().positive().optional(),
  /** conversão de NEGÓCIO do agente (o que conta como resultado — ex: purchase). */
  conversionGoal: conversionGoalSchema.optional(),
  /** id da conversão personalizada, quando `conversionGoal === "custom"`. */
  customConversionId: z.string().optional(),
});
export type AgentGoalsInput = z.infer<typeof agentGoalsInput>;

/** Config editável do agente: meta+conversão + personalização + janela (c1) +
 *  identidade/voz + cadência (c2). Todos opcionais (patch parcial). */
export const agentConfigInput = z.object({
  goals: agentGoalsInput.optional(),
  /** fatos do negócio (contexto) — camada aditiva no prompt. */
  businessContext: z.string().max(TEXT_FIELD_MAX).optional(),
  /** orientações de comportamento — camada aditiva no prompt. */
  guidance: z.string().max(TEXT_FIELD_MAX).optional(),
  /** identidade/voz (c2): persona + tom + override do prompt-base ("" = usa arquétipo). */
  persona: z.string().max(IDENTITY_FIELD_MAX).optional(),
  tone: z.string().max(IDENTITY_FIELD_MAX).optional(),
  systemPrompt: z.string().max(PROMPT_FIELD_MAX).optional(),
  /** cadência da análise automática (c2) — `CadenceSpec` (fonte única do cron).
   *  null = usar o default global (limpa a cadência própria). */
  cadence: cadenceSpecSchema.nullable().optional(),
  /** período de análise em dias (baseline espelha) — 1..30. */
  analysisWindowDays: z
    .number()
    .int()
    .min(ANALYSIS_WINDOW_MIN_DAYS)
    .max(ANALYSIS_WINDOW_MAX_DAYS)
    .optional(),
  /** autonomia por origem (playbook×llm) — só morde na escrita (5a). */
  autonomyPolicy: autonomyPolicySchema.optional(),
  /** guardrails (rede independente) — blast radius, cap, kill-switch, dry-run (5a). */
  guardrails: guardrailConfigSchema.optional(),
  /** "Opções avançadas" (6c) — override do model_config (modelos/revisão/limiares). */
  modelConfig: modelConfigInput.optional(),
});
export type AgentConfigInput = z.infer<typeof agentConfigInput>;

export const agentSummary = z.object({
  agentId: z.string(),
  archetype: z.string(),
  goals: agentGoalsInput,
  /** personalização por texto (Fatia 4) — null quando não configurada. */
  businessContext: z.string().nullable(),
  guidance: z.string().nullable(),
  /** identidade/voz (c2) — null quando não configurada (usa o arquétipo). */
  persona: z.string().nullable(),
  tone: z.string().nullable(),
  systemPrompt: z.string().nullable(),
  /** cadência configurada — null = usa o default global. */
  cadence: cadenceSpecSchema.nullable(),
  /** metodologia composta do arquétipo (read-only, p/ o "ver metodologia" quando o
   *  override está vazio). Deriva do arquétipo — não é editável. */
  methodologyPreview: z.string(),
  /** período de análise em dias (default quando não configurado). */
  analysisWindowDays: z.number(),
  /** análises automáticas pausadas pelo dono (freio self-service). */
  paused: z.boolean(),
  /** autonomia por origem (5a) — semeada pelo arquétipo. */
  autonomyPolicy: autonomyPolicySchema,
  /** guardrails (5a) — semeados na criação do agente. */
  guardrails: guardrailConfigSchema,
  /** "Opções avançadas" (6c) — overrides atuais do model_config (vazio = padrão do sistema). */
  modelConfig: modelConfigInput,
  /** defaults do sistema dos limiares de qualidade (env) — placeholder real na UI. */
  qualityDefaults: qualityDefaultsOutput,
});
export type AgentSummary = z.infer<typeof agentSummary>;

/** Catálogo de arquétipos p/ a UI de seleção (6c). */
export const archetypeOption = z.object({
  key: z.string(),
  label: z.string(),
  description: z.string(),
  whenToUse: z.string(),
});
export const archetypeCatalogOutput = z.object({ archetypes: z.array(archetypeOption) });
export type ArchetypeCatalogOutput = z.infer<typeof archetypeCatalogOutput>;

/** Re-seed do arquétipo (c2): reseta SÓ o comportamento, preserva meta+textos. */
export const reseedArchetypeInput = z.object({ archetype: z.string().min(1) });
export type ReseedArchetypeInput = z.infer<typeof reseedArchetypeInput>;

/** Uma conversão que a conta reportou (base do select anotado da config). */
export const availableConversion = z.object({
  goal: z.string(),
  customConversionId: z.string().optional(),
  /** total de eventos na janela recente (anota "0 eventos ⚠" / distingue as com dado). */
  count: z.number(),
  /** rótulo legível (nome real da personalizada, quando o worker já resolveu). */
  label: z.string().optional(),
});
export const availableConversionsOutput = z.object({
  conversions: z.array(availableConversion),
});
export type AvailableConversionsOutput = z.infer<typeof availableConversionsOutput>;

export const setPausedInput = z.object({ paused: z.boolean() });
export type SetPausedInput = z.infer<typeof setPausedInput>;

// ─── Playbook (Fatia 4 corte 2) ──────────────────────────────────────────
// Regra = SE [métrica op valor] (com gasto mínimo opcional) ENTÃO [ação], num nível.
// A JANELA por-regra NÃO é exposta (MVP: usa o "Período de análise" do agente); o
// engine ainda ignora `window` (fast-follow). CPA/ROAS seguem o basis no core.
/** Vocabulário de métricas da condição — todas existem em `InsightMetrics`. */
export const PLAYBOOK_METRICS = ["cpa", "roas", "spend", "cpc", "cpm", "ctr", "frequency"] as const;
export const playbookMetric = z.enum(PLAYBOOK_METRICS);
export const playbookOp = z.enum([">", "<", ">=", "<=", "=="]);
/** Nível-alvo da regra (nunca `account`). */
export const playbookScope = z.enum(["campaign", "adset", "ad"]);

/** Ação (então) — núcleo MVP: pausar / ajustar budget ±% / mudar status. */
export const playbookThen = z.discriminatedUnion("type", [
  z.object({ type: z.literal("pause_entity") }),
  z.object({ type: z.literal("adjust_budget"), budgetChangePct: z.number() }),
  z.object({ type: z.literal("set_status"), status: z.enum(["active", "paused"]) }),
]);
export type PlaybookThen = z.infer<typeof playbookThen>;

export const playbookRuleInput = z.object({
  scope: playbookScope,
  metric: playbookMetric,
  op: playbookOp,
  value: z.number(),
  /** só considera entidades com gasto ≥ este valor (evita CPA instável em pouco dado). */
  minSpend: z.number().min(0).optional(),
  then: playbookThen,
  enabled: z.boolean().optional(),
  priority: z.number().int().optional(),
});
export type PlaybookRuleInput = z.infer<typeof playbookRuleInput>;

export const playbookRuleOutput = z.object({
  id: z.string(),
  scope: playbookScope,
  metric: playbookMetric,
  op: playbookOp,
  value: z.number(),
  minSpend: z.number().nullable(),
  then: playbookThen,
  enabled: z.boolean(),
  priority: z.number().int(),
});
export type PlaybookRuleOutput = z.infer<typeof playbookRuleOutput>;

export const playbookRulesOutput = z.object({ rules: z.array(playbookRuleOutput) });
export type PlaybookRulesOutput = z.infer<typeof playbookRulesOutput>;

/** Resposta genérica de sucesso sem corpo (ex: delete). */
export const okOutput = z.object({ ok: z.boolean() });
export type OkOutput = z.infer<typeof okOutput>;

// Silenciar campanha (opt-out): exclui a campanha da análise do agente. `externalId`
// = id da campanha na plataforma (ex: id da campanha Meta).
export const muteCampaignInput = z.object({ externalId: z.string().min(1) });
export type MuteCampaignInput = z.infer<typeof muteCampaignInput>;

/** Lista de ids de campanhas silenciadas de uma conta. */
export const mutedCampaignsOutput = z.object({ campaignIds: z.array(z.string()) });
export type MutedCampaignsOutput = z.infer<typeof mutedCampaignsOutput>;

// ─── Ações aplicadas/sugeridas (mini-surface + undo, 5a/5b) ───────────────
/**
 * Uma ação APLICADA (ou simulada) — base do "reverter". Cross-run: dentro da
 * janela do TTL de revert, não só o run mais recente (uma aprovação pode ter sido
 * proposta por um run mais antigo que o decidido agora).
 */
export const appliedActionOutput = z.object({
  toolCallId: z.string(),
  // `type` = toolKey cru (um ActionType hoje). `z.string()` de propósito: forward-compat
  // com futuras tools do catálogo, sem quebrar a listagem se um toolKey novo aparecer.
  type: z.string(),
  targetLevel: z.string(),
  targetId: z.string(),
  /** rótulo legível (última análise conhecida) — ausente = UI cai pro id cru. */
  targetName: z.string().nullable(),
  /** dry-run (ensaio) — não escreveu de verdade. */
  simulated: z.boolean(),
  /** já foi revertida (existe o undo). */
  reverted: z.boolean(),
  /** pode reverter agora (real, não revertida, dentro do TTL). */
  undoable: z.boolean(),
  /** o re-check de drift barrou o revert — precisa confirmar ("mesmo assim"). */
  revertBlocked: z.boolean(),
  /** motivo do bloqueio de drift (quando `revertBlocked`). */
  revertBlockedReason: z.string().nullable(),
  /** true = aplicada por uma análise ANTERIOR à que está sendo vista (cross-run). */
  fromPreviousRun: z.boolean(),
});
/** Body do undo — `force` = reverter mesmo com drift ("mesmo assim"). */
export const undoActionInput = z.object({
  force: z.boolean().default(false),
});
export type UndoActionInput = z.infer<typeof undoActionInput>;
/**
 * Uma ação SUGERIDA (precisa de OK — não executou no auto-apply). Fonte da verdade =
 * tabela `approvals` (5b): por isso carrega `approvalId` (p/ aprovar/rejeitar) e o
 * prazo `expiresAt` (expira em 24h). São TODAS as pendentes do agente (cross-run).
 */
export const suggestedActionOutput = z.object({
  approvalId: z.string(),
  type: actionType,
  targetLevel: z.string(),
  targetId: z.string(),
  targetName: z.string().nullable(),
  reason: z.string(),
  /** ISO — prazo de resposta (expira e some da lista). */
  expiresAt: z.string().nullable(),
  /** true = proposta por uma análise ANTERIOR à que está sendo vista (cross-run). */
  fromPreviousRun: z.boolean(),
});
/** Uma ação BARRADA pelo guardrail (não executou nem virou sugestão) + o motivo. */
export const droppedActionOutput = z.object({
  type: actionType,
  targetLevel: z.string(),
  targetId: z.string(),
  targetName: z.string().nullable(),
  /** motivo legível do guardrail (ex: "entidade já está neste estado"). */
  reason: z.string(),
});
export const lastRunActionsOutput = z.object({
  runId: z.string().nullable(),
  applied: z.array(appliedActionOutput),
  suggested: z.array(suggestedActionOutput),
  dropped: z.array(droppedActionOutput),
});
export type LastRunActionsOutput = z.infer<typeof lastRunActionsOutput>;
