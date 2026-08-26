// Resolução da referência de mercado (pivô) — PURO. Junta o org-default com o
// override por agente na moeda da conta. Merge POR CAMPO: o override vence o
// org-default campo a campo. Campos em DINHEIRO (custo, zombie, baseline) de um
// lado só entram se a MOEDA daquele lado bate com a da conta (match-or-drop — nunca
// converte câmbio). `platform` (CTR/frequência) é agnóstico de moeda e sempre entra.

import type { MarketReference, OutcomeKind, RangeBand } from "@trafego/shared";
import { OUTCOME_KINDS } from "@trafego/shared";
import type { CtrBands } from "../benchmarks/index.js";

/** Piso de gasto/dia do sinal, por sensibilidade (espelha AlertSensitivity). */
export interface MinBaselineSpendBySensitivity {
  readonly low: number;
  readonly normal: number;
  readonly high: number;
}

/** Bits da referência já resolvidos p/ a moeda da conta (o que cada camada consome). */
export interface ResolvedMarketReference {
  /** faixas de custo (só as com moeda batendo) — referência direcional de cold-start. */
  readonly costTable?: Partial<Record<OutcomeKind, RangeBand>>;
  /** bandas de CTR (plataforma — sem moeda). */
  readonly ctrBands?: CtrBands;
  /** frequência de alerta (plataforma — sem moeda). */
  readonly frequencyAlert?: number;
  /** piso de gasto p/ zumbi (moeda batendo) — undefined = usa o fallback do sistema. */
  readonly zombieMinSpend?: number;
  /** piso de gasto/dia do sinal por sensibilidade (moeda batendo) — undefined = fallback. */
  readonly minBaselineSpend?: MinBaselineSpendBySensitivity;
}

/**
 * Extrai o override por-agente da referência de mercado do bag `model_config.quality`
 * (jsonb solto, validado na escrita pela API). PURO — só leitura defensiva.
 */
export function agentMarketReferenceFromModelConfig(
  modelConfig: Readonly<Record<string, unknown>> | null | undefined,
): MarketReference | null {
  const quality = modelConfig?.quality;
  if (!quality || typeof quality !== "object") return null;
  const ref = (quality as Record<string, unknown>).marketReference;
  return ref && typeof ref === "object" ? (ref as MarketReference) : null;
}

function pick<T>(a: T | undefined, b: T | undefined): T | undefined {
  return a !== undefined ? a : b;
}

/** Merge de custo por OutcomeKind: o override vence o org, campo a campo. */
function mergeCost(
  org: MarketReference["cost"],
  agent: MarketReference["cost"],
): Partial<Record<OutcomeKind, RangeBand>> | undefined {
  if (!org && !agent) return undefined;
  const out: Partial<Record<OutcomeKind, RangeBand>> = {};
  for (const kind of OUTCOME_KINDS) {
    const band = agent?.[kind] ?? org?.[kind];
    if (band) out[kind] = band;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

export function resolveMarketReference(
  orgDefault: MarketReference | null,
  agentOverride: MarketReference | null,
  accountCurrency: string | null,
): ResolvedMarketReference {
  // lados cujo DINHEIRO vale p/ esta conta = mesma moeda (match-or-drop).
  const orgMoney = orgDefault && accountCurrency && orgDefault.currency === accountCurrency ? orgDefault : null;
  const agentMoney =
    agentOverride && accountCurrency && agentOverride.currency === accountCurrency ? agentOverride : null;

  const costTable = mergeCost(orgMoney?.cost, agentMoney?.cost);
  // platform é agnóstico de moeda → usa o override (qualquer moeda) sobre o org.
  const ctrBands = pick(agentOverride?.platform?.ctrBands, orgDefault?.platform?.ctrBands);
  const frequencyAlert = pick(agentOverride?.platform?.frequencyAlert, orgDefault?.platform?.frequencyAlert);
  const zombieMinSpend = pick(agentMoney?.operational?.zombieMinSpend, orgMoney?.operational?.zombieMinSpend);
  const minBaselineSpend = pick(agentMoney?.operational?.minBaselineSpend, orgMoney?.operational?.minBaselineSpend);

  return {
    ...(costTable ? { costTable } : {}),
    ...(ctrBands ? { ctrBands } : {}),
    ...(frequencyAlert !== undefined ? { frequencyAlert } : {}),
    ...(zombieMinSpend !== undefined ? { zombieMinSpend } : {}),
    ...(minBaselineSpend ? { minBaselineSpend } : {}),
  };
}
