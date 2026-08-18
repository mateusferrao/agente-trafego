import type {
  ActionType,
  CandidateAction,
  InsightRow,
  PlaybookCondition,
  PlaybookRule,
  RiskLevel,
} from "@trafego/shared";

/**
 * Avalia o playbook determinístico: cada entidade × regra habilitada →
 * uma `CandidateAction` quando a condição vale (respeitando `minSpend`).
 *
 * Função PURA — sem IO, sem mock nos testes. É o coração testável do playbook.
 * As candidatas ainda passam por guardrail + decisão de autonomia depois.
 */
export function evaluatePlaybook(
  rules: PlaybookRule[],
  insights: InsightRow[],
): CandidateAction[] {
  const actions: CandidateAction[] = [];

  // maior prioridade primeiro (determinístico e estável)
  const activeRules = rules
    .filter((r) => r.enabled)
    .slice()
    .sort((a, b) => b.priority - a.priority);

  for (const rule of activeRules) {
    for (const row of insights) {
      // regra só se aplica ao seu nível-alvo (campaign|adset|ad)
      if (row.level !== rule.scope) continue;
      if (!conditionHolds(rule.when, row)) continue;

      const { type, ...params } = rule.then;
      actions.push({
        id: `${rule.id}:${row.entityId}`,
        type,
        target: { level: row.level, id: row.entityId },
        params,
        source: "playbook",
        riskLevel: riskForAction(type),
        reason: describeReason(rule.when, rule.id),
        ruleId: rule.id,
      });
    }
  }

  return actions;
}

/** Avalia a condição contra as métricas da linha (respeita `minSpend`). */
export function conditionHolds(cond: PlaybookCondition, row: InsightRow): boolean {
  // TODO: casar `cond.window` (3d/7d/14d) com a janela da linha quando os
  // insights vierem por dia. Hoje assume-se que `insights` já é a janela certa.
  if (cond.minSpend !== undefined && (row.metrics.spend ?? 0) < cond.minSpend) {
    return false;
  }
  const actual = row.metrics[cond.metric as keyof typeof row.metrics];
  if (actual === undefined || typeof actual !== "number") return false;
  return compare(actual, cond.op, cond.value);
}

function compare(a: number, op: PlaybookCondition["op"], b: number): boolean {
  switch (op) {
    case ">":
      return a > b;
    case "<":
      return a < b;
    case ">=":
      return a >= b;
    case "<=":
      return a <= b;
    case "==":
      return a === b;
    default:
      return false;
  }
}

/** Risco base por tipo de ação (defaults conservadores). */
function riskForAction(type: ActionType): RiskLevel {
  switch (type) {
    case "pause_entity":
    case "resume_entity":
      return "low";
    case "set_status":
      return "medium";
    case "adjust_budget":
      return "medium";
    default:
      return "medium";
  }
}

function describeReason(cond: PlaybookCondition, ruleId: string): string {
  return `Regra ${ruleId}: ${String(cond.metric)} ${cond.op} ${cond.value} (${cond.window})`;
}
