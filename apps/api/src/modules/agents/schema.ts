import { z } from "zod";

// 3a: superfície mínima do agente — só a META (target CPA/ROAS), que guia a
// análise. A config completa (persona/guardrails/autonomia/regras/tools) = Fatia 4.

export const agentGoalsInput = z.object({
  targetCPA: z.number().positive().optional(),
  targetROAS: z.number().positive().optional(),
});
export type AgentGoalsInput = z.infer<typeof agentGoalsInput>;

export const agentSummary = z.object({
  agentId: z.string(),
  archetype: z.string(),
  goals: agentGoalsInput,
  /** análises automáticas pausadas pelo dono (freio self-service). */
  paused: z.boolean(),
});
export type AgentSummary = z.infer<typeof agentSummary>;

export const setPausedInput = z.object({ paused: z.boolean() });
export type SetPausedInput = z.infer<typeof setPausedInput>;

// Silenciar campanha (opt-out): exclui a campanha da análise do agente. `externalId`
// = id da campanha na plataforma (ex: id da campanha Meta).
export const muteCampaignInput = z.object({ externalId: z.string().min(1) });
export type MuteCampaignInput = z.infer<typeof muteCampaignInput>;

/** Lista de ids de campanhas silenciadas de uma conta. */
export const mutedCampaignsOutput = z.object({ campaignIds: z.array(z.string()) });
export type MutedCampaignsOutput = z.infer<typeof mutedCampaignsOutput>;
