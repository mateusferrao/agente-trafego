import type { ConversionGoal, EntityObjective } from "@trafego/shared";

// Resolução PURA de "qual conversão conta" para CPA/ROAS de uma entidade.
// Único ponto onde vive a precedência: override do agente (personalização,
// Fatia 4) vence o objetivo que o usuário já configurou na plataforma. Só fala
// o vocabulário genérico — o mapeamento específico de plataforma vive no adapter.

/** A conversão a contar (goal + id da personalizada, quando for o caso). */
export interface ResolvedConversion {
  readonly goal: ConversionGoal;
  readonly customConversionId?: string;
}

/**
 * `null` quando não há conversão definida (ex: entidade otimizando cliques) —
 * nesse caso a análise julga por CPC/CPM, não por CPA.
 */
export function resolveConversion(
  objective: EntityObjective | undefined,
  override?: ResolvedConversion,
): ResolvedConversion | null {
  if (override) return override;
  if (objective) {
    return {
      goal: objective.goal,
      ...(objective.customConversionId ? { customConversionId: objective.customConversionId } : {}),
    };
  }
  return null;
}
