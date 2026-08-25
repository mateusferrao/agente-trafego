import type {
  ActionType,
  RecommendationActionType,
  RecommendationApplicability,
  RecommendationKind,
  RiskLevel,
} from "@trafego/shared";
import { riskForAction } from "../risk/index.js";

/**
 * Risco por tipo de ação (nível-tipo, sem params) — delega à fonte única
 * `riskForAction`. Sem direção de budget → `adjust_budget` cai no `medium`
 * conservador; o caminho de escrita passa os params p/ refinar (decrease = low).
 */
export function riskLevelForActionType(type: ActionType): RiskLevel {
  return riskForAction(type);
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

/**
 * Classifica o `actionType` sugerido pelo LLM (8 tipos) no `kind` persistido (3) —
 * o eixo real de renderização/gating. PURA. Antes, os tipos consultivos eram
 * DESCARTADOS (viravam `proposedAction=null` sem rótulo); aqui viram `human_direction`
 * (direção que o humano executa) ou `insight` (leitura, sem ação). As ações
 * executáveis viram `platform_action` (coerente com `applicableActionType !== null`).
 */
const KIND_BY_RECOMMENDATION: Readonly<Record<RecommendationActionType, RecommendationKind>> = {
  pause: "platform_action",
  resume: "platform_action",
  increase_budget: "platform_action",
  decrease_budget: "platform_action",
  review_creative: "human_direction",
  review_audience: "human_direction",
  investigate: "human_direction",
  keep: "insight",
};

export function kindForRecommendation(recActionType: RecommendationActionType): RecommendationKind {
  return KIND_BY_RECOMMENDATION[recActionType];
}

/** Direção do ajuste de budget (p/ `params`), quando aplicável. */
export function budgetDirection(
  recActionType: RecommendationActionType,
): "increase" | "decrease" | null {
  if (recActionType === "increase_budget") return "increase";
  if (recActionType === "decrease_budget") return "decrease";
  return null;
}
