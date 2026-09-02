import type { Action, AutonomyLevel, AutonomyPolicy } from "@trafego/shared";
import {
  ACTION_PARAM_AMOUNT_MINOR,
  ACTION_PARAM_MODE,
  ACTION_PARAM_PCT,
  BUDGET_MODE_DECREASE,
  BUDGET_MODE_SET,
} from "@trafego/shared";
import { type DroppedAction, entityKeyOf } from "../guardrails/index.js";

/**
 * Edição do VALOR de uma ação `adjust_budget` pendente ANTES de aprovar (C, v1) — PURA. O dono
 * corrige o quanto: `pct` (increase/decrease em %) OU `absolute` (valor/dia em unidade mínima).
 * Só valida/monta os params; o CLAMP do blast-radius é rede do apply (guardrail fresco). Retorna
 * a ação atualizada ou um erro tipado (nunca lança). Só `adjust_budget` tem valor editável.
 */
export type BudgetEdit =
  | { readonly kind: "pct"; readonly mode: "increase" | "decrease"; readonly pct: number }
  | { readonly kind: "absolute"; readonly amountMinor: number };

export type BudgetEditResult = { readonly ok: true; readonly action: Action } | { readonly ok: false; readonly error: string };

export function editBudgetActionValue(action: Action, edit: BudgetEdit): BudgetEditResult {
  if (action.type !== "adjust_budget") return { ok: false, error: "só dá pra editar o valor de um ajuste de orçamento" };
  if (edit.kind === "pct") {
    if (!Number.isFinite(edit.pct) || edit.pct <= 0) return { ok: false, error: "a porcentagem precisa ser um número maior que zero" };
    return {
      ok: true,
      action: { ...action, params: { ...action.params, [ACTION_PARAM_MODE]: edit.mode, [ACTION_PARAM_PCT]: edit.pct } },
    };
  }
  if (!Number.isInteger(edit.amountMinor) || edit.amountMinor <= 0) {
    return { ok: false, error: "o valor do orçamento precisa ser maior que zero" };
  }
  return {
    ok: true,
    action: { ...action, params: { ...action.params, [ACTION_PARAM_MODE]: BUDGET_MODE_SET, [ACTION_PARAM_AMOUNT_MINOR]: edit.amountMinor } },
  };
}

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
 * Decide o que auto-aplica vs. o que precisa de OK humano. A autonomia da ação (B) é
 * resolvida POR-AÇÃO com fallback POR-ORIGEM: `byAction[toolKey]` VENCE `bySource[source]`
 * (ausente = herda a origem). O toolKey de uma ação de escrita == o `action.type` (as 4
 * mutações têm chave idêntica ao tipo).
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
    const level = resolveAutonomyLevel(autonomy, action);
    if (isAutoApplicable(level, action)) {
      autoApply.push(action);
    } else {
      needApproval.push(action);
    }
  }

  return { autoApply, needApproval };
}

/** Nível de autonomia efetivo da ação: por-ação (toolKey) vence, senão por-origem. PURA. */
export function resolveAutonomyLevel(autonomy: AutonomyPolicy, action: Action): AutonomyLevel {
  return autonomy.byAction?.[action.type] ?? autonomy.bySource[action.source];
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
