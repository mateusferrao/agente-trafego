// Referência de plataforma (Fatia 6c / pivô) — PURO. Prior DIRECIONAL de cold-start:
// só entra quando NÃO há meta do dono E NÃO há histórico da conta. Nunca é a meta
// e nunca declara sucesso — só dá uma âncora no 1º run e evita o LLM chamar um
// número claramente fora de "normal" de aceitável. Comparador nº1 continua sendo
// a meta do dono; nº2/3 o histórico/relativo da própria conta.
//
// Pivô B2B/B2C: as faixas de custo NÃO são mais hardcoded por vertical — vêm da
// `MarketReference` configurável (org + override por agente), já resolvida na moeda
// da conta pelo `resolveMarketReference`. Sem faixa preenchida → não injeta custo.
// CTR/frequência têm default de plataforma (Meta), overridável pela mesma tabela.

import type { BenchmarkCtrRating, BenchmarkRef, ConversionGoal, OutcomeKind, RangeBand } from "@trafego/shared";

/** Mapeia a conversão de negócio (neutra) → grupo de custo. `undefined` = sem faixa. */
export function outcomeKindFor(goal: ConversionGoal | undefined): OutcomeKind | undefined {
  switch (goal) {
    case "messaging_started":
    case "contact":
      return "conversation";
    case "lead":
    case "registration":
    case "submit_application":
    case "subscribe":
    case "start_trial":
      return "lead";
    case "purchase":
    case "initiate_checkout":
    case "add_to_cart":
    case "add_payment_info":
      return "sale";
    default:
      return undefined;
  }
}

/** Rótulos PT das faixas de custo por grupo de resultado (o usuário só informa min/max). */
export const COST_LABELS: Readonly<Record<OutcomeKind, string>> = {
  conversation: "custo por conversa",
  lead: "custo por lead",
  sale: "custo por venda",
};

/** Faixas CTR de bandas (%) — banda de plataforma (Meta). Default overridável pela tabela. */
export interface CtrBands {
  readonly ok: number;
  readonly good: number;
  readonly great: number;
}
/** Default de plataforma do CTR (link), %. Não-monetário → default de plataforma (não pede config),
 *  overridável pela `MarketReference`. Fonte fiel: squad Meta (`docs/referencia-traffic-masters.md`
 *  §5 — média 0,90% / bom 1,5% / ótimo 2,5%). CVR/hook-retention first-class = fast-follow (ROADMAP). */
export const CTR_BANDS: CtrBands = { ok: 0.9, good: 1.5, great: 2.5 };

/** Classifica o CTR (%) em rótulo direcional vs a plataforma (bandas overridáveis). */
export function ctrRating(ctr: number, bands: CtrBands = CTR_BANDS): BenchmarkCtrRating {
  if (ctr >= bands.great) return "otimo";
  if (ctr >= bands.good) return "bom";
  if (ctr >= bands.ok) return "ok";
  return "ruim";
}

/** Default de plataforma da frequência de alerta em prospecção (público frio). Não-monetário →
 *  default de plataforma. Fonte fiel: squad Meta (prospecting_max 2,5; fadiga ~3,0). */
export const FREQUENCY_PROSPECTING_ALERT = 2.5;

/** ROAS de referência (quando há receita) — direcional. */
export const ROAS_REFERENCE = 2;

export interface BenchmarkInput {
  /** CTR (%) da entidade/conta. */
  readonly ctr: number;
  /** Frequência (impressões/alcance), quando disponível. */
  readonly frequency?: number;
  /** Conversão de negócio (define a faixa de custo). */
  readonly outcomeGoal?: ConversionGoal;
  /** Moeda da conta (rótulo da faixa). */
  readonly currency: string;
  /** true = sem meta E sem histórico (o único caso em que a referência entra). */
  readonly coldStart: boolean;
  /** Faixas de custo já resolvidas na moeda da conta (ausente = não injeta custo). */
  readonly costTable?: Partial<Record<OutcomeKind, RangeBand>>;
  /** Bandas de CTR override (senão default de plataforma). */
  readonly ctrBands?: CtrBands;
  /** Frequência de alerta override (senão default de plataforma). */
  readonly frequencyAlert?: number;
}

/**
 * Monta a referência de plataforma. Só produz `costReference`/ratings quando
 * `coldStart` — fora do cold-start devolve `{ coldStart: false }` (a UI/prompt não
 * mostram referência; o comparador é a meta/histórico). Sem `costTable` p/ o grupo
 * de resultado → não injeta faixa de custo (não inventa referência).
 */
export function benchmarkFor(input: BenchmarkInput): BenchmarkRef {
  if (!input.coldStart) return { coldStart: false };
  const kind = outcomeKindFor(input.outcomeGoal);
  const band = kind ? input.costTable?.[kind] : undefined;
  const freqThreshold = input.frequencyAlert ?? FREQUENCY_PROSPECTING_ALERT;
  return {
    coldStart: true,
    ctrRating: ctrRating(input.ctr, input.ctrBands),
    ...(input.frequency !== undefined ? { frequencyAlert: input.frequency > freqThreshold } : {}),
    ...(band && kind
      ? { costReference: { label: COST_LABELS[kind], min: band.min, max: band.max, currency: input.currency } }
      : {}),
  };
}
