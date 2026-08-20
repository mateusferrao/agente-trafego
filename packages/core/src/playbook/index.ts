import type {
  CandidateAction,
  ConversionBasis,
  InsightMetrics,
  InsightRow,
  PlaybookCondition,
  PlaybookRule,
} from "@trafego/shared";
import { ACTION_PARAM_MODE, ACTION_PARAM_PCT, BUDGET_MODE_DECREASE, BUDGET_MODE_INCREASE } from "@trafego/shared";
import { riskForAction } from "../risk/index.js";

/**
 * Resolução da conversão de NEGÓCIO do agente por entidade (basis + métricas de
 * negócio). Chave = `${level}:${entityId}`. Produzida pela curadoria (brief), a
 * partir da mesma classificação de basis (§7) — fonte única `classifyBasis`.
 */
export interface EntityConversionResolution {
  readonly basis: ConversionBasis;
  readonly metrics: InsightMetrics;
}

/**
 * Métricas de conversão (CPA/ROAS) — seguem o basis: só valem numa entidade onde a
 * conversão de negócio é mensurável (`target`). As demais (spend/cpc/cpm/ctr/
 * frequency) são sempre-mensuráveis e vêm cruas da linha.
 */
const CONVERSION_METRICS: ReadonlySet<string> = new Set(["cpa", "roas"]);

/**
 * Avalia o playbook determinístico: cada entidade × regra habilitada →
 * uma `CandidateAction` quando a condição vale (respeitando `minSpend`).
 *
 * Função PURA — sem IO, sem mock nos testes. É o coração testável do playbook.
 * As candidatas ainda passam por guardrail + decisão de autonomia depois.
 *
 * `resolutionByKey` (opcional): quando fornecido, as métricas de conversão (CPA/
 * ROAS) seguem o basis — só disparam em entidades `target` e usam o custo de
 * NEGÓCIO. Ausente (uso legado/teste) → cai pro valor cru da linha.
 */
export function evaluatePlaybook(
  rules: readonly PlaybookRule[],
  insights: readonly InsightRow[],
  resolutionByKey?: ReadonlyMap<string, EntityConversionResolution>,
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
      const resolution = resolutionByKey?.get(`${row.level}:${row.entityId}`);
      if (!conditionHolds(rule.when, row, resolution)) continue;

      const { type } = rule.then;
      const params = actionParamsFromThen(rule.then);
      actions.push({
        id: `${rule.id}:${row.entityId}`,
        type,
        target: { level: row.level, id: row.entityId },
        params,
        source: "playbook",
        riskLevel: riskForAction(type, params),
        reason: describeReason(rule.when),
        ruleId: rule.id,
      });
    }
  }

  return actions;
}

/** Avalia a condição contra as métricas da linha (respeita `minSpend` e o basis). */
export function conditionHolds(
  cond: PlaybookCondition,
  row: InsightRow,
  resolution?: EntityConversionResolution,
): boolean {
  // TODO(fast-follow): casar `cond.window` (3d/7d/14d) com a janela da linha quando
  // os insights vierem por dia. Hoje assume-se que `insights` já é a janela do agente.
  if (cond.minSpend !== undefined && (row.metrics.spend ?? 0) < cond.minSpend) {
    return false;
  }
  const actual = resolveMetric(cond.metric, row, resolution);
  if (actual === undefined || typeof actual !== "number") return false;
  return compare(actual, cond.op, cond.value);
}

/**
 * Métrica-alvo da condição. CPA/ROAS seguem o basis (só `target`, valor de negócio);
 * o resto vem cru da linha. Sem resolução → comportamento legado (valor cru).
 */
function resolveMetric(
  metric: PlaybookCondition["metric"],
  row: InsightRow,
  resolution?: EntityConversionResolution,
): number | undefined {
  if (CONVERSION_METRICS.has(metric as string)) {
    if (resolution) {
      if (resolution.basis !== "target") return undefined; // proxy/none → não casa
      return resolution.metrics[metric as keyof InsightMetrics];
    }
    return row.metrics[metric as keyof typeof row.metrics] as number | undefined;
  }
  return row.metrics[metric as keyof typeof row.metrics] as number | undefined;
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

/**
 * `rule.then` (DTO com `budgetChangePct` assinado) → `Action.params` uniforme.
 * `adjust_budget` vira `{ mode, pct=magnitude }` (mesmo shape do caminho do LLM) —
 * sem isso o executor/guardrail leriam `pct` errado. PURO.
 */
function actionParamsFromThen(then: PlaybookRule["then"]): Record<string, unknown> {
  const rec = then as unknown as Record<string, unknown>;
  if (then.type === "adjust_budget") {
    const raw = Number(rec["budgetChangePct"]);
    const magnitude = Number.isFinite(raw) ? Math.abs(raw) : 0;
    return {
      [ACTION_PARAM_MODE]: raw < 0 ? BUDGET_MODE_DECREASE : BUDGET_MODE_INCREASE,
      [ACTION_PARAM_PCT]: magnitude,
    };
  }
  const { type: _type, ...rest } = rec;
  return rest;
}

/** Rótulo legível por métrica — mesma nomenclatura do editor de regras (web). */
const METRIC_LABEL: Record<string, string> = {
  spend: "gasto",
  impressions: "impressões",
  clicks: "cliques",
  ctr: "CTR",
  cpc: "CPC",
  cpm: "CPM",
  frequency: "frequência",
  conversions: "conversões",
  cpa: "CPA",
  roas: "ROAS",
};

const OP_LABEL: Record<PlaybookCondition["op"], string> = {
  ">": "maior que",
  "<": "menor que",
  ">=": "maior ou igual a",
  "<=": "menor ou igual a",
  "==": "igual a",
};

/** Descrição legível da condição — sem id cru (o `ruleId` já vai à parte em `CandidateAction.ruleId`). */
function describeReason(cond: PlaybookCondition): string {
  const metric = METRIC_LABEL[cond.metric] ?? String(cond.metric);
  return `${metric} ${OP_LABEL[cond.op]} ${cond.value} (últimos ${cond.window.replace("d", " dias")})`;
}
