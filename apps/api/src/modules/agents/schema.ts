import { z } from "zod";
import { conversionGoalSchema } from "@trafego/shared/schemas";

// Fatia 4 (corte 1): meta + conversão de negócio + personalização por texto.
// (autonomia/guardrails/playbook = próximo corte.)

/** Teto de caracteres dos campos de texto livre (guarda prompt inchado). */
const TEXT_FIELD_MAX = 2000;

export const agentGoalsInput = z.object({
  targetCPA: z.number().positive().optional(),
  targetROAS: z.number().positive().optional(),
  /** conversão de NEGÓCIO do agente (o que conta como resultado — ex: purchase). */
  conversionGoal: conversionGoalSchema.optional(),
  /** id da conversão personalizada, quando `conversionGoal === "custom"`. */
  customConversionId: z.string().optional(),
});
export type AgentGoalsInput = z.infer<typeof agentGoalsInput>;

/** Config editável do agente neste corte: meta+conversão + personalização por texto. */
export const agentConfigInput = z.object({
  goals: agentGoalsInput.optional(),
  /** fatos do negócio (contexto) — camada aditiva no prompt. */
  businessContext: z.string().max(TEXT_FIELD_MAX).optional(),
  /** orientações de comportamento — camada aditiva no prompt. */
  guidance: z.string().max(TEXT_FIELD_MAX).optional(),
});
export type AgentConfigInput = z.infer<typeof agentConfigInput>;

export const agentSummary = z.object({
  agentId: z.string(),
  archetype: z.string(),
  goals: agentGoalsInput,
  /** personalização por texto (Fatia 4) — null quando não configurada. */
  businessContext: z.string().nullable(),
  guidance: z.string().nullable(),
  /** análises automáticas pausadas pelo dono (freio self-service). */
  paused: z.boolean(),
});
export type AgentSummary = z.infer<typeof agentSummary>;

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

// Silenciar campanha (opt-out): exclui a campanha da análise do agente. `externalId`
// = id da campanha na plataforma (ex: id da campanha Meta).
export const muteCampaignInput = z.object({ externalId: z.string().min(1) });
export type MuteCampaignInput = z.infer<typeof muteCampaignInput>;

/** Lista de ids de campanhas silenciadas de uma conta. */
export const mutedCampaignsOutput = z.object({ campaignIds: z.array(z.string()) });
export type MutedCampaignsOutput = z.infer<typeof mutedCampaignsOutput>;
