import { z } from "zod";

/** Recomendação aninhada no evento do run (híbrido expansível — 6a). */
export const timelineRecommendation = z.object({
  id: z.string(),
  title: z.string(),
  riskLevel: z.string().nullable(),
  status: z.string(),
});
export type TimelineRecommendation = z.infer<typeof timelineRecommendation>;

const base = { id: z.string(), at: z.string() };

/** Evento de ação (aplicada/revertida). */
const actionEvent = <T extends string>(type: T) =>
  z.object({
    ...base,
    type: z.literal(type),
    toolCallId: z.string(),
    toolKey: z.string(),
    entityName: z.string().nullable(),
    fromChat: z.boolean(),
    simulated: z.boolean(),
  });

/** Evento de aprovação (pedida/aprovada/rejeitada/expirada). */
const approvalEvent = <T extends string>(type: T) =>
  z.object({
    ...base,
    type: z.literal(type),
    approvalId: z.string(),
    actionType: z.string(),
    entityName: z.string().nullable(),
  });

/** Evento de rascunho de campanha (Fatia 7 — proposto/criado). */
const draftEvent = <T extends string>(type: T) =>
  z.object({
    ...base,
    type: z.literal(type),
    draftId: z.string(),
    kind: z.string(),
    dailyBudgetReais: z.number(),
  });

/**
 * Evento da Timeline (união discriminada ABERTA por `type`) — extensível: Fatia 7
 * (campaign_draft_proposed/created) e outros encaixam sem reescrever o consumidor.
 */
export const timelineEvent = z.discriminatedUnion("type", [
  z.object({
    ...base,
    type: z.literal("analysis_completed"),
    runId: z.string(),
    grade: z.string().nullable(),
    headline: z.string().nullable(),
    recommendationCount: z.number(),
    recommendations: z.array(timelineRecommendation),
  }),
  z.object({ ...base, type: z.literal("error"), runId: z.string(), message: z.string() }),
  actionEvent("action_applied"),
  actionEvent("action_rolled_back"),
  approvalEvent("approval_requested"),
  approvalEvent("approval_approved"),
  approvalEvent("approval_rejected"),
  approvalEvent("approval_expired"),
  draftEvent("campaign_draft_proposed"),
  draftEvent("campaign_created"),
]);
export type TimelineEvent = z.infer<typeof timelineEvent>;

export const timelineOutput = z.object({
  items: z.array(timelineEvent),
  hasMore: z.boolean(),
});
export type TimelineOutput = z.infer<typeof timelineOutput>;
