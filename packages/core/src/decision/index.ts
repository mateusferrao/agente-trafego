import type { Action, AutonomyLevel, AutonomyPolicy } from "@trafego/shared";
import { ACTION_PARAM_MODE, BUDGET_MODE_DECREASE } from "@trafego/shared";
import { type DroppedAction, entityKeyOf } from "../guardrails/index.js";

export interface DecisionResult {
  readonly autoApply: Action[];
  readonly needApproval: Action[];
}

export interface ConflictResult {
  readonly kept: Action[];
  readonly dropped: DroppedAction[];
}

/**
 * Resolve conflitos + dedupe ANTES da decisão de autonomia: no máximo **uma ação por
 * entidade** (`${level}:${id}`), a de maior dominância. "Pausar/parar domina": nunca
 * aumenta gasto numa entidade que outra regra quer frear. Empate → playbook
 * (determinístico) vence LLM, depois a ordem original. Mantém a ordem das mantidas.
 * Função PURA.
 */
export function resolveActionConflicts(actions: readonly Action[]): ConflictResult {
  const byEntity = new Map<string, Action[]>();
  for (const action of actions) {
    const key = entityKeyOf(action.target);
    (byEntity.get(key) ?? byEntity.set(key, []).get(key)!).push(action);
  }

  const winners = new Set<Action>();
  const dropped: DroppedAction[] = [];
  for (const group of byEntity.values()) {
    const winner = group.reduce((best, cur) => (beats(cur, best) ? cur : best));
    winners.add(winner);
    for (const a of group) {
      if (a !== winner) dropped.push({ action: a, reason: `conflito na entidade: '${winner.type}' tem prioridade` });
    }
  }

  // preserva a ordem original das mantidas
  const kept = actions.filter((a) => winners.has(a));
  return { kept, dropped };
}

/** Dominância na resolução de conflito: pausar > cortar > status > aumentar > religar. */
function dominanceOf(a: Action): number {
  switch (a.type) {
    case "pause_entity":
      return 4;
    case "adjust_budget":
      return a.params[ACTION_PARAM_MODE] === BUDGET_MODE_DECREASE ? 3 : 1;
    case "set_status":
      return 2;
    case "resume_entity":
      return 0;
    default:
      return 0;
  }
}

/** `cur` vence `best`? maior dominância; empate → playbook vence LLM (senão mantém best). */
function beats(cur: Action, best: Action): boolean {
  const d = dominanceOf(cur) - dominanceOf(best);
  if (d !== 0) return d > 0;
  return cur.source === "playbook" && best.source !== "playbook";
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
export function decideActions(
  actions: readonly Action[],
  autonomy: AutonomyPolicy,
): DecisionResult {
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
