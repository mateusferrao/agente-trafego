import type { Action, AutonomyLevel, AutonomyPolicy } from "@trafego/shared";

export interface DecisionResult {
  readonly autoApply: Action[];
  readonly needApproval: Action[];
}

/**
 * Decide, POR ORIGEM da ação, o que auto-aplica vs. o que precisa de OK humano.
 * Autonomia é configurada por origem (`playbook` × `llm`) na `AutonomyPolicy`.
 *
 * Níveis:
 *  - notify    → só avisa; nunca aplica → aprovação
 *  - suggest   → sugere + OK → aprovação
 *  - act_safe  → aplica sozinho só risco `low`; resto → aprovação
 *  - act_full  → aplica sozinho sempre
 *
 * Função PURA.
 */
export function decideActions(actions: Action[], autonomy: AutonomyPolicy): DecisionResult {
  const autoApply: Action[] = [];
  const needApproval: Action[] = [];

  for (const action of actions) {
    const level = autonomy.bySource[action.source];
    if (isAutoApplicable(level, action)) {
      autoApply.push(action);
    } else {
      needApproval.push(action);
    }
  }

  return { autoApply, needApproval };
}

function isAutoApplicable(level: AutonomyLevel, action: Action): boolean {
  switch (level) {
    case "act_full":
      return true;
    case "act_safe":
      return action.riskLevel === "low";
    case "suggest":
    case "notify":
      return false;
    default:
      return false;
  }
}
