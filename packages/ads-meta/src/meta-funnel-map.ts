// Mapa Meta → funil neutro (§7: vocabulário da plataforma vive SÓ no adapter).
// Deriva o funil de messaging a partir do `rawActions` já coletado (sem re-sync).
// DATA-DRIVEN: mapeia só os action_types conhecidos e presentes; ignora o resto —
// resiliente à depreciação de métricas da Meta (o que sumir simplesmente não entra).

import type { FunnelBreakdown, FunnelStage } from "@trafego/shared";

const ONSITE_PREFIX = "onsite_conversion.";

/** Sufixo do action_type (após `onsite_conversion.`) → estágio neutro do funil. */
const MESSAGING_FUNNEL: Readonly<Record<string, FunnelStage>> = {
  messaging_conversation_started_7d: "conversation_started",
  messaging_first_reply: "first_reply",
  messaging_user_depth_2_message_send: "depth_2",
  messaging_user_depth_3_message_send: "depth_3",
  messaging_user_depth_5_message_send: "depth_5",
  messaging_conversation_replied_7d: "replied",
};

/** Estágio neutro p/ um action_type da Meta (tolera com/sem o prefixo onsite). */
export function funnelStageFromActionType(actionType: string): FunnelStage | null {
  const suffix = actionType.startsWith(ONSITE_PREFIX)
    ? actionType.slice(ONSITE_PREFIX.length)
    : actionType;
  return MESSAGING_FUNNEL[suffix] ?? null;
}

/** Deriva o funil neutro do breakdown cru (`action_type → count`). PURO. */
export function funnelFromRawActions(
  rawActions: Readonly<Record<string, number>> | undefined,
): FunnelBreakdown {
  if (!rawActions) return [];
  const byStage = new Map<FunnelStage, number>();
  for (const [actionType, count] of Object.entries(rawActions)) {
    const stage = funnelStageFromActionType(actionType);
    if (!stage) continue;
    byStage.set(stage, (byStage.get(stage) ?? 0) + count);
  }
  return [...byStage.entries()].map(([stage, count]) => ({ stage, count }));
}
