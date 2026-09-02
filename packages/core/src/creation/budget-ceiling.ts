// Sinal de TETO DE BUDGET por-campanha (P1.2) — alimenta `detectCreationOpportunities`
// (scale_winner) e o gate do AUTO-apply autônomo (só `true` confirmado autoriza duplicar/escalar
// sozinho). Cobertura total: CBO (budget na própria campanha) + ABO (agrega os adsets ATIVOS
// filhos) + vitalício (usa `budgetRemaining`, que a Meta já contabiliza — sem pacing por data).
// Puro — zero IO, testado sem mock.

import type { EntityBudget, EntitySummary } from "@trafego/shared";

/** Vitalício com ≤15% do budget restante = no teto (a Meta já contabiliza — mais preciso que
 *  qualquer pacing por data que a gente tentasse recalcular). */
const DEFAULT_LIFETIME_REMAINING_PCT = 15;
/** Diário com gasto médio/dia ≥80% do budget = no teto. */
const DEFAULT_DAILY_SPEND_PCT = 80;

export interface BudgetCeilingThresholds {
  /** limiar de teto do DIÁRIO — gasto médio/dia ≥ X% do budget diário. */
  readonly dailySpendPct?: number;
  /** limiar de teto do VITALÍCIO — budget restante ≤ X% do total. */
  readonly lifetimeRemainingPct?: number;
}

export interface AttachBudgetCeilingInput {
  readonly campaigns: readonly EntitySummary[];
  readonly adsets: readonly EntitySummary[];
  /** tamanho da janela de `metrics.spend` (dias) — normaliza pra gasto médio/dia. */
  readonly windowDays: number;
  readonly thresholds?: BudgetCeilingThresholds;
}

/**
 * Anexa `atBudgetCeiling` em cada campanha. CBO usa o budget da PRÓPRIA campanha; ABO (campanha
 * sem budget próprio) agrega os adsets ATIVOS filhos via `campaignId`. Vitalício tem prioridade
 * sobre diário quando os dois estão presentes (mais preciso — a Meta já contabiliza o saldo).
 * Sem NENHUM dado de budget (nem próprio, nem ABO) → `atBudgetCeiling` ausente (honesto; não
 * bloqueia a proposta pro humano revisar — só barra o AUTO-apply autônomo).
 */
export function attachBudgetCeiling(input: AttachBudgetCeilingInput): EntitySummary[] {
  const dailyPct = input.thresholds?.dailySpendPct ?? DEFAULT_DAILY_SPEND_PCT;
  const remainingPct = input.thresholds?.lifetimeRemainingPct ?? DEFAULT_LIFETIME_REMAINING_PCT;

  const activeChildrenByCampaign = new Map<string, EntitySummary[]>();
  for (const a of input.adsets) {
    if (!a.campaignId || a.status !== "active") continue;
    const list = activeChildrenByCampaign.get(a.campaignId) ?? [];
    list.push(a);
    activeChildrenByCampaign.set(a.campaignId, list);
  }

  return input.campaigns.map((c) => {
    const hasOwnBudget = (c.budget?.dailyMajor ?? 0) > 0 || (c.budget?.lifetimeMajor ?? 0) > 0;
    if (hasOwnBudget) {
      const ceiling = ceilingFromBudget(c.budget!, c.metrics.spend ?? 0, input.windowDays, dailyPct, remainingPct);
      return ceiling === undefined ? c : { ...c, atBudgetCeiling: ceiling };
    }

    // ABO: sem budget próprio → agrega os adsets ATIVOS filhos (o budget mora neles).
    const children = activeChildrenByCampaign.get(c.id) ?? [];
    const aggregated = aggregateChildBudgets(children);
    if (!aggregated) return c;
    const childSpend = children.reduce((sum, a) => sum + (a.metrics.spend ?? 0), 0);
    const ceiling = ceilingFromBudget(aggregated, childSpend, input.windowDays, dailyPct, remainingPct);
    return ceiling === undefined ? c : { ...c, atBudgetCeiling: ceiling };
  });
}

/** Soma o budget dos adsets filhos (ABO) — diário e vitalício somados separadamente (uma
 *  campanha ABO pode ter mix de adsets diário/vitalício; agrega cada eixo dentre os que o têm). */
function aggregateChildBudgets(children: readonly EntitySummary[]): EntityBudget | null {
  let dailyTotal = 0;
  let hasDaily = false;
  let lifetimeTotal = 0;
  let remainingTotal = 0;
  let hasLifetime = false;

  for (const child of children) {
    if (child.budget?.dailyMajor) {
      dailyTotal += child.budget.dailyMajor;
      hasDaily = true;
    }
    if (child.budget?.lifetimeMajor) {
      lifetimeTotal += child.budget.lifetimeMajor;
      hasLifetime = true;
      if (typeof child.budget.lifetimeRemainingMajor === "number") {
        remainingTotal += child.budget.lifetimeRemainingMajor;
      }
    }
  }
  if (!hasDaily && !hasLifetime) return null;
  return {
    ...(hasDaily ? { dailyMajor: dailyTotal } : {}),
    ...(hasLifetime ? { lifetimeMajor: lifetimeTotal, lifetimeRemainingMajor: remainingTotal } : {}),
  };
}

/** `undefined` = indeterminável (nem vitalício nem diário resolvível) — o caller preserva
 *  `atBudgetCeiling` ausente nesse caso (não confunde com `false` de folga confirmada). */
function ceilingFromBudget(
  budget: EntityBudget,
  windowSpend: number,
  windowDays: number,
  dailyPct: number,
  remainingPct: number,
): boolean | undefined {
  if (budget.lifetimeMajor && budget.lifetimeMajor > 0 && typeof budget.lifetimeRemainingMajor === "number") {
    const remainingRatioPct = (budget.lifetimeRemainingMajor / budget.lifetimeMajor) * 100;
    return remainingRatioPct <= remainingPct;
  }
  if (budget.dailyMajor && budget.dailyMajor > 0 && windowDays > 0) {
    const avgDaily = windowSpend / windowDays;
    const ratioPct = (avgDaily / budget.dailyMajor) * 100;
    return ratioPct >= dailyPct;
  }
  return undefined;
}
