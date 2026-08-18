import type { Action, CandidateAction, GuardrailConfig } from "@trafego/shared";

export interface DroppedAction {
  readonly action: Action;
  readonly reason: string;
}

export interface GuardrailResult {
  readonly allowed: Action[];
  readonly dropped: DroppedAction[];
}

/**
 * Rede de segurança sobre as candidatas (playbook + LLM). Sempre roda, mesmo
 * no caminho autônomo — é a ÚNICA rede quando não há eco+confirma.
 *
 * Ordem: killSwitch → allowedActions → clamp de budget → cap de entidades/dia.
 * Função PURA.
 */
export function applyGuardrails(
  actions: CandidateAction[],
  cfg: GuardrailConfig,
): GuardrailResult {
  const allowed: Action[] = [];
  const dropped: DroppedAction[] = [];

  // kill-switch: nada passa
  if (cfg.killSwitch) {
    return { allowed: [], dropped: actions.map((a) => ({ action: a, reason: "kill switch ativo" })) };
  }

  const seenEntities = new Set<string>();

  for (const action of actions) {
    // 1) tipo de ação permitido?
    if (!cfg.allowedActions.includes(action.type)) {
      dropped.push({ action, reason: `ação ${action.type} não permitida` });
      continue;
    }

    // 2) clamp de % de mudança de budget (não descarta, limita)
    const clamped = clampBudgetChange(action, cfg.maxBudgetChangePct);

    // 3) cap de entidades/dia — conta entidades distintas afetadas
    const entityKey = `${clamped.target.level}:${clamped.target.id}`;
    if (!seenEntities.has(entityKey)) {
      if (seenEntities.size >= cfg.maxEntitiesPerDay) {
        dropped.push({ action: clamped, reason: "limite de entidades/dia atingido" });
        continue;
      }
      seenEntities.add(entityKey);
    }

    allowed.push(clamped);
  }

  // NOTA: `cfg.dryRun` não descarta ações aqui — é aplicado na casca (nó
  // apply_actions), que só simula a mutação. `cfg.llmCostCapUsd` é checado no
  // metering antes de chamar o LLM, fora do guardrail de ações.
  return { allowed, dropped };
}

/** Limita a magnitude de mudança de budget ao teto configurado. */
function clampBudgetChange(action: Action, maxPct: number): Action {
  if (action.type !== "adjust_budget") return action;
  const pct = action.params["pct"];
  if (typeof pct !== "number" || Math.abs(pct) <= maxPct) return action;

  const sign = pct < 0 ? -1 : 1;
  return {
    ...action,
    params: { ...action.params, pct: sign * maxPct, clampedFrom: pct },
  };
}
