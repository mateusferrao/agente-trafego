import type {
  ActionType,
  RecommendationActionType,
  RecommendationApplicability,
  RiskLevel,
} from "@trafego/shared";

/**
 * Risco determinístico por tipo de ação — base do `riskLevel` de recommendations
 * (e das actions no caminho de escrita). Função PURA. Mudou o leque de ações?
 * o `Record` exaustivo força atualizar o mapa (sem default silencioso).
 */
const RISK_BY_ACTION_TYPE: Readonly<Record<ActionType, RiskLevel>> = {
  pause_entity: "low", // pausar interrompe gasto, reversível
  resume_entity: "medium", // religar volta a gastar
  adjust_budget: "medium", // altera gasto (o guardrail limita o %)
  set_status: "medium",
};

export function riskLevelForActionType(type: ActionType): RiskLevel {
  return RISK_BY_ACTION_TYPE[type];
}

/**
 * Aplicabilidade na fase **read-only** (3a/3b): não há caminho de escrita, então
 * toda recomendação nasce `not_yet_applicable`. Fonte única — a Fatia 5 (write path)
 * substitui por lógica de capacidade real sem espalhar strings pelo código.
 */
export const READ_ONLY_APPLICABILITY: RecommendationApplicability = "not_yet_applicable";

/**
 * Traduz o `actionType` sugerido pelo LLM p/ o `ActionType` aplicável do sistema,
 * ou `null` quando a sugestão é só **consultiva** (revisar/investigar/manter) — aí
 * a recomendação não carrega `proposedAction` tipado. PURA.
 */
const ACTION_TYPE_BY_RECOMMENDATION: Readonly<Record<RecommendationActionType, ActionType | null>> = {
  pause: "pause_entity",
  resume: "resume_entity",
  increase_budget: "adjust_budget",
  decrease_budget: "adjust_budget",
  review_creative: null,
  review_audience: null,
  investigate: null,
  keep: null,
};

export function applicableActionType(recActionType: RecommendationActionType): ActionType | null {
  return ACTION_TYPE_BY_RECOMMENDATION[recActionType];
}

/** Direção do ajuste de budget (p/ `params`), quando aplicável. */
export function budgetDirection(
  recActionType: RecommendationActionType,
): "increase" | "decrease" | null {
  if (recActionType === "increase_budget") return "increase";
  if (recActionType === "decrease_budget") return "decrease";
  return null;
}
