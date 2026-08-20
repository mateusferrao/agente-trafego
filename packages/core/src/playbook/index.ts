import type {
  CandidateAction,
  ConversionBasis,
  InsightMetrics,
  InsightRow,
  PlaybookCondition,
  PlaybookRule,
} from "@trafego/shared";
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

      const { type, ...params } = rule.then;
      actions.push({
        id: `${rule.id}:${row.entityId}`,
        type,
        target: { level: row.level, id: row.entityId },
        params,
        source: "playbook",
        riskLevel: riskForAction(type, params),
        reason: describeReason(rule.when, rule.id),
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

function describeReason(cond: PlaybookCondition, ruleId: string): string {
  return `Regra ${ruleId}: ${String(cond.metric)} ${cond.op} ${cond.value} (${cond.window})`;
}
