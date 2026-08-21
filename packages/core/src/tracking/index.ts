// Detector de tracking/atribuição furado (§Bloco 2) — PURO. Sinaliza, sobre o
// dado já curado, que a MEDIÇÃO de venda/lead da conta parece incompleta: muito
// funil (conversas) e pouquíssima conversão de negócio rastreada. Não é veredito
// (os anúncios podem estar ótimos e a venda fechar fora do rastreio — o caso do
// ICP: conversa no anúncio, venda no atendimento). Alimenta uma nota no prompt e
// o guard suave (caveat nas pausas por CPA de venda).

import type { ConversionGoal, TrackingHealth } from "@trafego/shared";

/**
 * Metas de negócio cuja conversão pode fechar FORA da plataforma (risco de a Meta
 * subcontar). `messaging_started`/`view_content`/`search`/`app_install` NÃO entram
 * (a "conversão" é on-platform/rasa; não há o que a plataforma deixe de ver).
 */
const OFF_PLATFORM_GOALS: ReadonlySet<ConversionGoal> = new Set([
  "purchase",
  "lead",
  "registration",
  "initiate_checkout",
  "add_to_cart",
  "add_payment_info",
  "subscribe",
  "start_trial",
  "submit_application",
  "contact",
  "custom",
]);

export interface TrackingThresholds {
  /** conversas / max(conversões,1) >= isto → suspeita. */
  readonly ratio: number;
  /** volume mínimo de conversas p/ sequer considerar (evita ruído em conta pequena). */
  readonly minFunnel: number;
}

export interface DetectTrackingInput {
  /** meta de negócio do agente (só metas off-platform disparam). */
  readonly conversionGoal?: ConversionGoal;
  /** conversas agregadas da conta (conversation_started). */
  readonly funnelStarted: number;
  /** conversões de negócio RASTREADAS agregadas. */
  readonly trackedConversions: number;
  readonly thresholds: TrackingThresholds;
}

/**
 * Sinal de conta (nível agregado): `undefined` quando não faz sentido (meta não
 * off-platform) ou não é suspeito. A aplicação por-entidade (caveat na pausa certa)
 * é do guard `guardTrackingCaveat`, que resolve a base pelo brief.
 */
export function detectTrackingHealth(input: DetectTrackingInput): TrackingHealth | undefined {
  if (!input.conversionGoal || !OFF_PLATFORM_GOALS.has(input.conversionGoal)) return undefined;
  const { funnelStarted, trackedConversions } = input;
  const ratio = funnelStarted / Math.max(trackedConversions, 1);
  const suspect = funnelStarted >= input.thresholds.minFunnel && ratio >= input.thresholds.ratio;
  if (!suspect) return undefined;
  return { suspect: true, funnelStarted, trackedConversions, ratio: Math.round(ratio * 10) / 10 };
}
