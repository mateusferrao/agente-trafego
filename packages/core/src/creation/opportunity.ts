import type { CreationOpportunity, EntityLevel, PerformanceTier } from "@trafego/shared";

/** Entidade curada p/ detectar oportunidade de criação (vem da camada de qualidade 6c). */
export interface OpportunityEntity {
  readonly id: string;
  readonly level: EntityLevel;
  readonly name?: string;
  readonly tier?: PerformanceTier;
  /** significância de negócio (conversões/cliques + baseline) — 6c. */
  readonly significant: boolean;
  /** gasto encostando no teto de budget (capado → dá pra escalar). */
  readonly atBudgetCeiling: boolean;
  /** criativo fatigado (fadiga/saturação) — 6c. */
  readonly fatigued: boolean;
  /** ainda gastando de verdade (não zumbi). */
  readonly spending: boolean;
}

export interface DetectOpportunitiesInput {
  /** a conta tem campanha ativa? (false → cold_start). */
  readonly hasActiveCampaigns: boolean;
  readonly entities: readonly OpportunityEntity[];
}

/** Prioridade: escalar provado > refrescar fadiga > começar do zero. */
const PRIORITY: Readonly<Record<CreationOpportunity["kind"], number>> = {
  scale_winner: 0,
  refresh_fatigued: 1,
  cold_start: 2,
};

/**
 * Detecta oportunidades de criação (determinístico, PURO) — irmã de detectMaterialChange.
 * scale_winner: vencedor significativo batendo o teto de budget. refresh_fatigued: entidade
 * fatigada ainda gastando. cold_start: conta sem campanha ativa. Ordena por prioridade;
 * o caller pega o top-1 (throttle 1/conta). Nunca "alucina" — só o que os sinais confirmam.
 */
export function detectCreationOpportunities(input: DetectOpportunitiesInput): CreationOpportunity[] {
  const out: CreationOpportunity[] = [];

  for (const e of input.entities) {
    if (e.tier === "winner" && e.significant && e.atBudgetCeiling) {
      out.push({
        kind: "scale_winner",
        entityLevel: e.level,
        entityId: e.id,
        ...(e.name ? { entityName: e.name } : {}),
        rationale: `"${e.name ?? e.id}" é seu melhor em custo por resultado e está no teto de budget — dá pra escalar.`,
      });
    } else if (e.fatigued && e.spending) {
      out.push({
        kind: "refresh_fatigued",
        entityLevel: e.level,
        entityId: e.id,
        ...(e.name ? { entityName: e.name } : {}),
        rationale: `"${e.name ?? e.id}" está com sinais de fadiga — vale testar um ângulo novo.`,
      });
    }
  }

  if (!input.hasActiveCampaigns) {
    out.push({
      kind: "cold_start",
      rationale: "a conta está sem campanha ativa — posso montar uma campanha inicial pra não deixar parada.",
    });
  }

  return out.sort((a, b) => PRIORITY[a.kind] - PRIORITY[b.kind]);
}
