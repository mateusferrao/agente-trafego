import type { FunnelBreakdown, FunnelStage, FunnelSummary } from "@trafego/shared";

/**
 * Curadoria PURA do funil de messaging (§ROADMAP nota 3a): contagens por estágio
 * + **taxas** derivadas (qualidade do lead do ICP — não só volume). Taxa é o sinal
 * real: "30 conversas com 15 indo fundo" > "100 com 4". Guarda ÷0.
 */

/** Soma vários breakdowns por estágio (agrega dias/rows de uma entidade). */
export function mergeFunnel(breakdowns: readonly FunnelBreakdown[]): FunnelBreakdown {
  const byStage = new Map<FunnelStage, number>();
  for (const breakdown of breakdowns) {
    for (const { stage, count } of breakdown) {
      byStage.set(stage, (byStage.get(stage) ?? 0) + count);
    }
  }
  return [...byStage.entries()].map(([stage, count]) => ({ stage, count }));
}

/** Resumo do funil (contagens + replyRate/depthRate). `undefined` se vazio. */
export function computeFunnelSummary(breakdown: FunnelBreakdown): FunnelSummary | undefined {
  if (breakdown.length === 0) return undefined;

  const counts: Partial<Record<FunnelStage, number>> = {};
  for (const { stage, count } of breakdown) {
    counts[stage] = (counts[stage] ?? 0) + count;
  }

  const started = counts.conversation_started ?? 0;
  const replyRate =
    started > 0 && counts.first_reply !== undefined ? round(counts.first_reply / started) : undefined;
  // "foi fundo" = depth_3 (canônico) ou, na falta, depth_2.
  const deep = counts.depth_3 ?? counts.depth_2;
  const depthRate = started > 0 && deep !== undefined ? round(deep / started) : undefined;

  return {
    counts,
    ...(replyRate !== undefined ? { replyRate } : {}),
    ...(depthRate !== undefined ? { depthRate } : {}),
  };
}

function round(x: number): number {
  return Math.round(x * 10000) / 10000;
}

/** Abaixo disso, a 1ª resposta é rara demais — lead frio mesmo com CPL/CPA aparentemente bom. */
const LOW_REPLY_RATE_THRESHOLD = 0.5;
/** Amostra mínima de conversas pra o sinal não ser ruído estatístico. */
const MIN_CONVERSATIONS_FOR_LEAD_QUALITY_SIGNAL = 10;

/**
 * A qualidade do lead (taxa de 1ª resposta) está ruim o bastante pra merecer ressalva ANTES
 * de qualquer métrica de vaidade (CPL/CPA aparentemente bom) — a armadilha clássica de saúde
 * (Playbook Steticos, item 5): CPL ótimo não significa nada se o lead nem responde. Usado pelo
 * redator (`notify/prompt.ts`) pra ordenar a mensagem quando `vertical === "health"`. PURO.
 */
export function hasLeadQualityCaveat(funnel: FunnelSummary | undefined): boolean {
  if (!funnel || funnel.replyRate === undefined) return false;
  const started = funnel.counts.conversation_started ?? 0;
  if (started < MIN_CONVERSATIONS_FOR_LEAD_QUALITY_SIGNAL) return false;
  return funnel.replyRate < LOW_REPLY_RATE_THRESHOLD;
}
