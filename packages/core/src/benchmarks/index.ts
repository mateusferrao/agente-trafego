// Referência de plataforma (Fatia 6c) — PURO. Prior DIRECIONAL de cold-start:
// só entra quando NÃO há meta do dono E NÃO há histórico da conta. Nunca é a meta
// e nunca declara sucesso — só dá uma âncora no 1º run e evita o LLM chamar um
// número claramente fora de "normal" de aceitável. Comparador nº1 continua sendo
// a meta do dono; nº2/3 o histórico/relativo da própria conta.
//
// Extensível: hoje 1 vertical implícito (saúde) — a chave real é o TIPO DE CONVERSÃO
// (conversa/lead/venda). Nova vertical = adicionar a dimensão quando houver o campo.

import type { BenchmarkCtrRating, BenchmarkRef, ConversionGoal } from "@trafego/shared";

/** Agrupamento neutro do resultado de negócio p/ a faixa de custo de referência. */
export type OutcomeKind = "conversation" | "lead" | "sale";

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

/** Faixas de CTR (link) da Meta — direcional, %. Fonte: benchmarks de plataforma. */
export const CTR_BANDS = { ok: 0.9, good: 1.5, great: 2.5 } as const;

/** Classifica o CTR (%) em rótulo direcional vs a plataforma. */
export function ctrRating(ctr: number): BenchmarkCtrRating {
  if (ctr >= CTR_BANDS.great) return "otimo";
  if (ctr >= CTR_BANDS.good) return "bom";
  if (ctr >= CTR_BANDS.ok) return "ok";
  return "ruim";
}

/** Frequência de alerta em prospecção (público frio) — acima disso, satura rápido. */
export const FREQUENCY_PROSPECTING_ALERT = 2.5;

/**
 * Faixas de custo-por-resultado de cold-start (saúde, BRL) — EDITÁVEIS (default do
 * sistema; override por env/por-agente). Rotuladas como referência, nunca meta.
 */
export interface CostReferenceBand {
  readonly label: string;
  readonly min: number;
  readonly max: number;
}
export const DEFAULT_COST_REFERENCE_BRL: Readonly<Record<OutcomeKind, CostReferenceBand>> = {
  conversation: { label: "custo por conversa", min: 3, max: 15 },
  lead: { label: "custo por lead", min: 15, max: 60 },
  sale: { label: "custo por venda", min: 40, max: 120 },
};

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
  /** Tabela de faixas (default do sistema ou override). */
  readonly costTable?: Readonly<Record<OutcomeKind, CostReferenceBand>>;
}

/**
 * Monta a referência de plataforma. Só produz `costReference`/ratings quando
 * `coldStart` — fora do cold-start devolve `{ coldStart: false }` (a UI/promtp não
 * mostram referência; o comparador é a meta/histórico).
 */
export function benchmarkFor(input: BenchmarkInput): BenchmarkRef {
  if (!input.coldStart) return { coldStart: false };
  const table = input.costTable ?? DEFAULT_COST_REFERENCE_BRL;
  const kind = outcomeKindFor(input.outcomeGoal);
  const band = kind ? table[kind] : undefined;
  return {
    coldStart: true,
    ctrRating: ctrRating(input.ctr),
    ...(input.frequency !== undefined ? { frequencyAlert: input.frequency > FREQUENCY_PROSPECTING_ALERT } : {}),
    ...(band
      ? { costReference: { label: band.label, min: band.min, max: band.max, currency: input.currency } }
      : {}),
  };
}
