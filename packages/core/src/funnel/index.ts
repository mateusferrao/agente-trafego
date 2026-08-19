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
