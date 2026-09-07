import type { Action, AutonomyLevel, AutonomyPolicy, Ressalva } from "@trafego/shared";
import {
  ACTION_PARAM_AMOUNT_MINOR,
  ACTION_PARAM_MODE,
  ACTION_PARAM_PCT,
  BUDGET_MODE_DECREASE,
  BUDGET_MODE_INCREASE,
  BUDGET_MODE_SET,
} from "@trafego/shared";
import { type DroppedAction, entityKeyOf } from "../guardrails/index.js";
import { isScaleAction } from "../scale-ressalvas/index.js";

/**
 * Projeta o orçamento RESULTANTE (unidade mínima) de uma ação `adjust_budget` dado o
 * orçamento ATUAL, só para EXIBIÇÃO (card de aprovação / detalhe mostram "atual → proposto").
 * Espelha a matemática do apply SEM o clamp do blast-radius (o clamp fresco é rede do apply;
 * o card mostra o proposto + a ressalva do teto, como o eco). `set` → o valor absoluto pedido
 * (independe do atual); `increase`/`decrease` → atual ±pct%. Retorna null quando não dá pra
 * projetar (pct sem atual conhecido, sem pct/valor, modo desconhecido). PURA.
 */
export function projectBudgetTargetMinor(
  currentMinor: number | null,
  params: Readonly<Record<string, unknown>>,
): number | null {
  const mode = params[ACTION_PARAM_MODE];
  if (mode === BUDGET_MODE_SET) {
    const amount = Number(params[ACTION_PARAM_AMOUNT_MINOR]);
    return Number.isFinite(amount) && amount > 0 ? Math.round(amount) : null;
  }
  if (mode !== BUDGET_MODE_INCREASE && mode !== BUDGET_MODE_DECREASE) return null;
  if (currentMinor == null || !(currentMinor > 0)) return null;
  const pct = Number(params[ACTION_PARAM_PCT]);
  if (!Number.isFinite(pct) || pct < 0) return null;
  const sign = mode === BUDGET_MODE_DECREASE ? -1 : 1;
  return Math.round(currentMinor * (1 + (sign * pct) / 100));
}

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

/** Dedupe de ressalvas por código (preserva a 1ª mensagem de cada código). PURA. */
function dedupeRessalvas(rs: readonly Ressalva[]): Ressalva[] {
  const seen = new Set<string>();
  const out: Ressalva[] = [];
  for (const r of rs) {
    if (seen.has(r.code)) continue;
    seen.add(r.code);
    out.push(r);
  }
  return out;
}

/** Funde um grupo de ações de escala da MESMA entidade numa só: pct mais CONSERVADOR
 *  (menor alta de orçamento) + UNIÃO das ressalvas. Mantém a 1ª ação como base. PURA. */
function mergeScaleGroup(group: readonly Action[]): Action {
  const base = group[0]!;
  const ressalvas = dedupeRessalvas(group.flatMap((a) => a.ressalvas ?? []));
  const incPcts = group
    .filter((a) => a.type === "adjust_budget" && a.params[ACTION_PARAM_MODE] === BUDGET_MODE_INCREASE)
    .map((a) => Number(a.params[ACTION_PARAM_PCT]))
    .filter((n) => Number.isFinite(n) && n > 0);
  const params =
    base.type === "adjust_budget" && incPcts.length > 0
      ? { ...base.params, [ACTION_PARAM_PCT]: Math.min(...incPcts) }
      : base.params;
  return { ...base, params, ...(ressalvas.length > 0 ? { ressalvas } : {}) };
}

/**
 * Coalesce ações de ESCALA da MESMA entidade numa única (pct conservador + ressalvas somadas),
 * ANTES do `resolveActionConflicts`. Fecha o bug em que a escala do LLM e a determinística caíam
 * na mesma campanha como duas ações — o dedupe por dominância descartaria uma (perdendo pct/
 * ressalvas), aqui a gente FUNDE. Não-escala passam intactas, na ordem original (a fundida ocupa
 * a posição da 1ª do grupo). Função PURA.
 */
export function coalesceScaleActions(actions: readonly Action[]): Action[] {
  // chave = entidade + TIPO: só funde escala do MESMO tipo (2× adjust_budget de aumento — o
  // caso do bug). resume + increase na mesma entidade ficam separados (tipos distintos, efeitos
  // distintos) → o resolveActionConflicts resolve por dominância, sem perder a ação de budget.
  const keyOf = (a: Action): string => `${entityKeyOf(a.target)}:${a.type}`;
  const groups = new Map<string, Action[]>();
  for (const a of actions) {
    if (!isScaleAction(a)) continue;
    const key = keyOf(a);
    (groups.get(key) ?? groups.set(key, []).get(key)!).push(a);
  }
  const emitted = new Set<string>();
  const out: Action[] = [];
  for (const a of actions) {
    if (!isScaleAction(a)) {
      out.push(a);
      continue;
    }
    const key = keyOf(a);
    if (emitted.has(key)) continue;
    emitted.add(key);
    out.push(mergeScaleGroup(groups.get(key)!));
  }
  return out;
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
  // Ressalva (Fatia A): "dá pra fazer, mas há um risco" → NUNCA aplica sozinha, nem em act_full.
  // Trava a mão automática mas mantém a ação aprovável (o dono decide com o aviso à vista).
  if (action.ressalvas && action.ressalvas.length > 0) return false;
  // adjust_audience (Fatia C): editar público de adset vivo RESETA o aprendizado da Meta (irreversível)
  // e é julgamento do LLM sem backstop determinístico → SEMPRE exige OK humano (nunca auto, nem act_full).
  if (action.type === "adjust_audience") return false;
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
