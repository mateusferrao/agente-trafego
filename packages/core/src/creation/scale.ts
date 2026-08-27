import type { CampaignDraft, DuplicateEntityInput } from "@trafego/shared";

/** Sufixo de nome da entidade duplicada (distingue do original no Ads Manager). */
const DUPLICATE_RENAME_SUFFIX = "escala";

/** Onde mora o budget: adset (ABO) ou campanha (CBO). */
export type BudgetLevel = "adset" | "campaign";

/**
 * Como escalar o vencedor (decisão #8). `raise_budget` = sobe o budget do nível dono
 * (reusa `adjust_budget`, preserva learning em passo moderado). `duplicate` = isola o
 * gasto novo num adset copiado (passo agressivo em ABO).
 */
export type ScaleMove =
  | { readonly move: "raise_budget"; readonly pct: number; readonly level: BudgetLevel }
  | { readonly move: "duplicate"; readonly scalePct: number };

export interface PlanScaleMoveInput {
  readonly scalePct: number;
  readonly maxBudgetChangePct: number;
  readonly budgetLevel: BudgetLevel;
}

/**
 * Escala inteligente por passo. CBO → sobe o budget da campanha (duplicar adset não
 * escala sob CBO). ABO → passo ≤ faixa segura sobe o budget do adset; passo agressivo
 * (> faixa) duplica o adset pra isolar sem estourar o learning do original. PURO.
 */
export function planScaleMove(input: PlanScaleMoveInput): ScaleMove {
  const { scalePct, maxBudgetChangePct, budgetLevel } = input;
  if (budgetLevel === "campaign") {
    return { move: "raise_budget", pct: scalePct, level: "campaign" };
  }
  if (scalePct <= maxBudgetChangePct) {
    return { move: "raise_budget", pct: scalePct, level: "adset" };
  }
  return { move: "duplicate", scalePct };
}

/**
 * Traduz um rascunho `duplicate` na entrada neutra de duplicação (a saga chama o adapter).
 * Omite `destinationCampaignId` — a cópia de adset entra na MESMA campanha por default.
 * PURO. Lança se faltar `sourceRef` (rascunho de duplicação sempre tem origem).
 */
export function buildDuplicateInput(draft: CampaignDraft): DuplicateEntityInput {
  if (draft.kind !== "duplicate" || !draft.sourceRef) {
    throw new Error("buildDuplicateInput: rascunho não é de duplicação ou não tem sourceRef");
  }
  return {
    sourceLevel: draft.sourceRef.level,
    sourceId: draft.sourceRef.id,
    status: draft.spec.activation,
    renameSuffix: DUPLICATE_RENAME_SUFFIX,
  };
}
