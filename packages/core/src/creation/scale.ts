import type { CampaignBudgetLayout, CampaignDraft, DuplicateEntityInput } from "@trafego/shared";

/** Sufixo de nome da entidade duplicada (distingue do original no Ads Manager). */
const DUPLICATE_RENAME_SUFFIX = "escala";

/** Onde mora o budget: adset (ABO) ou campanha (CBO). */
export type BudgetLevel = "adset" | "campaign";

/** Onde aplicar o novo budget de uma duplicação de CAMPANHA (o card "com mais budget"): campanha
 *  (CBO) ou um valor por conjunto (ABO). */
export type ScaledBudgetPlan =
  | { readonly kind: "campaign"; readonly dailyMinor: number }
  | { readonly kind: "adsets"; readonly budgets: ReadonlyArray<{ readonly id: string; readonly dailyMinor: number }> };

/**
 * Decide onde/como aplicar o novo orçamento diário (`targetDailyMinor`) numa campanha duplicada,
 * conforme o modelo: **CBO** → seta na campanha; **ABO** → distribui entre os conjuntos
 * proporcional ao orçamento atual de cada um, com **soma EXATA = alvo** (o resto de arredondamento
 * vai pros maiores). ABO sem base de orçamento (defensivo, raro) → cai no nível campanha. PURA.
 */
export function planScaledBudget(layout: CampaignBudgetLayout, targetDailyMinor: number): ScaledBudgetPlan {
  if (layout.campaignDailyMinor !== null) return { kind: "campaign", dailyMinor: targetDailyMinor };
  const total = layout.adsets.reduce((s, a) => s + a.dailyMinor, 0);
  if (layout.adsets.length === 0 || total <= 0) return { kind: "campaign", dailyMinor: targetDailyMinor };
  const budgets = layout.adsets.map((a) => ({ id: a.id, dailyMinor: Math.floor((a.dailyMinor / total) * targetDailyMinor) }));
  // garante a soma EXATA: distribui o resto (1 unidade/vez) começando pelos maiores conjuntos.
  let remainder = targetDailyMinor - budgets.reduce((s, b) => s + b.dailyMinor, 0);
  const byLargest = [...budgets].sort((a, b) => b.dailyMinor - a.dailyMinor);
  for (let i = 0; remainder > 0; i = (i + 1) % byLargest.length, remainder--) byLargest[i]!.dailyMinor += 1;
  return { kind: "adsets", budgets };
}

/**
 * Como escalar o vencedor (decisão #8). `raise_budget` = sobe o budget do nível dono
 * (reusa `adjust_budget`, preserva learning em passo moderado). `duplicate` = isola o
 * gasto novo num adset copiado (passo agressivo em ABO). `ask` = passo agressivo com
 * intent aberto → PERGUNTA (subir seguro vs duplicar) em vez de auto-decidir (§eco+confirma).
 */
export type ScaleMove =
  | { readonly move: "raise_budget"; readonly pct: number; readonly level: BudgetLevel }
  | { readonly move: "duplicate"; readonly scalePct: number }
  | { readonly move: "ask"; readonly raisePct: number; readonly duplicatePct: number };

/** Preferência lembrada por-agente p/ o passo agressivo (tira a fricção do perguntar sempre). */
export type ScaleAggressivePreference = "ask" | "raise" | "duplicate";
/** Resposta explícita do usuário ao ASK — vence a preferência. */
export type ScaleChoice = "raise" | "duplicate";

export interface PlanScaleMoveInput {
  readonly scalePct: number;
  readonly maxBudgetChangePct: number;
  readonly budgetLevel: BudgetLevel;
  /** Como resolver o passo agressivo quando o usuário não respondeu ainda. Default `ask`. */
  readonly preference?: ScaleAggressivePreference;
  /** Resposta do usuário ao ASK (vence a preferência). */
  readonly choice?: ScaleChoice;
}

/**
 * Escala inteligente por passo. CBO → sobe o budget da campanha (duplicar adset não
 * escala sob CBO). ABO → passo ≤ faixa segura sobe o budget do adset; passo agressivo
 * (> faixa) resolve por `choice` > `preference`; sem resolução → `ask` (não auto-decide).
 * `raise` no agressivo = sobe clampado à faixa segura (não reinicia o learning); `duplicate`
 * = isola o gasto novo pra crescer além disso. PURO.
 */
export function planScaleMove(input: PlanScaleMoveInput): ScaleMove {
  const { scalePct, maxBudgetChangePct, budgetLevel, preference = "ask", choice } = input;
  if (budgetLevel === "campaign") {
    // CBO não pode isolar por duplicação (duplicar adset não escala sob CBO) → só resta
    // subir o budget da campanha, mas LIMITADO à faixa segura: o guardrail clamparia o
    // excesso em silêncio, e o eco+confirma (§8) tem que prometer o valor REAL aplicado.
    return { move: "raise_budget", pct: Math.min(scalePct, maxBudgetChangePct), level: "campaign" };
  }
  if (scalePct <= maxBudgetChangePct) {
    return { move: "raise_budget", pct: scalePct, level: "adset" };
  }
  // passo agressivo (ABO): choice (resposta) vence a preferência; nenhuma → pergunta.
  const resolution = choice ?? (preference === "ask" ? undefined : preference);
  if (resolution === "raise") return { move: "raise_budget", pct: maxBudgetChangePct, level: "adset" };
  if (resolution === "duplicate") return { move: "duplicate", scalePct };
  return { move: "ask", raisePct: maxBudgetChangePct, duplicatePct: scalePct };
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
    // rótulo editável do sufixo (Slice 7/9): `<vencedor> — <rótulo>`. Ausente → "escala".
    renameSuffix: draft.spec.suffixLabel ?? DUPLICATE_RENAME_SUFFIX,
  };
}
