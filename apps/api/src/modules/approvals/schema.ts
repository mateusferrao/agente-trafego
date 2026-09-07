import { z } from "zod";
import { actionType, applyPreviewSchema, ressalvaSchema } from "@trafego/shared/schemas";
import { explicitAudienceInput } from "../drafts/schema.js";

const approvalStatusOutput = z.enum(["pending", "approved", "rejected", "expired", "blocked"]);

/** Público EXPLÍCITO proposto de uma ação `adjust_audience` (Fatia C) — semente do editor do site
 *  (`GeoAudienceEditor`, mesmo dos rascunhos). Opcionais normalizados em `null`. */
const explicitAudienceView = z.object({
  geo: z.array(z.object({ key: z.string(), name: z.string(), kind: z.enum(["country", "region", "city"]), radius: z.number().nullable(), distanceUnit: z.enum(["mile", "kilometer"]).nullable() })),
  radiusAreas: z.array(z.object({ address: z.string(), radius: z.number(), distanceUnit: z.enum(["mile", "kilometer"]) })),
  ageMin: z.number().nullable(),
  ageMax: z.number().nullable(),
  genders: z.array(z.union([z.literal(1), z.literal(2)])).nullable(),
  interestGroups: z.array(z.array(z.object({ id: z.string(), name: z.string() }))),
  behaviorGroups: z.array(z.array(z.object({ id: z.string(), name: z.string() }))),
  customAudienceIncludeIds: z.array(z.string()),
  customAudienceExcludeIds: z.array(z.string()),
});

/** Uma aprovação pendente (granular, 5b) — caixa de entrada cross-conta. */
export const approvalOutput = z.object({
  id: z.string(),
  accountId: z.string(),
  accountName: z.string(),
  entityLevel: z.string(),
  entityId: z.string(),
  entityName: z.string().nullable(),
  type: actionType,
  reason: z.string(),
  status: approvalStatusOutput,
  /** ISO — prazo de resposta (expira em 24h e some da lista). */
  expiresAt: z.string().nullable(),
  /** Moeda da conta (ISO, ex "BRL"/"USD") — formata os valores no card. Null = desconhecida. */
  currency: z.string().nullable(),
  /** Orçamento ATUAL da entidade (unidade MAIOR, ex reais) na proposta — só `adjust_budget`
   *  com atual conhecido; o card mostra "atual → proposto". Null nos demais casos. */
  currentBudgetMajor: z.number().nullable(),
  /** Orçamento PROPOSTO resultante (unidade MAIOR) — projeção p/ exibição (pré-clamp). Null
   *  quando não dá pra projetar (sem atual, sem pct/valor) ou ação não é de orçamento. */
  targetBudgetMajor: z.number().nullable(),
  /** Público EXPLÍCITO proposto — só `adjust_audience` (Fatia C); semente do editor no card.
   *  Null nos demais tipos. Editar o público reseta o aprendizado da Meta (aviso no card). */
  audience: explicitAudienceView.nullable(),
  /** O que APROVAR faz (informativo — o gating real é do apply): `real`/`simulated`/`blocked` +
   *  a linha honesta na voz do Roy. Computado no servidor (guardrail + capacidade, mesma fonte do
   *  apply). O card avisa/bloqueia a partir disto (fonte única, não recomputa). */
  applyPreview: applyPreviewSchema,
  /** Ressalvas de escala (Fatia A): o "porém" honesto — aprovável-com-aviso. Null = sem ressalva. */
  ressalvas: z.array(ressalvaSchema).nullable(),
});
export type ApprovalOutput = z.infer<typeof approvalOutput>;

export const approvalsListOutput = z.array(approvalOutput);

/** Resolução por-ação (corte 1). Batch conversacional (WhatsApp) = corte 2. */
export const resolveApprovalInput = z.object({
  decision: z.enum(["approve", "reject"]),
});
export type ResolveApprovalInput = z.infer<typeof resolveApprovalInput>;

export const resolveApprovalOutput = z.object({
  id: z.string(),
  status: approvalStatusOutput,
});
export type ResolveApprovalOutput = z.infer<typeof resolveApprovalOutput>;

/** Desfecho da APLICAÇÃO de uma aprovação (Fatia "depois") — o card faz polling disto após aprovar
 *  pra virar "Aplicando…" no resultado real. `applyOutcome` null = ainda sem tentativa/aplicando;
 *  `outcomeMessage` = frase na voz do Roy (fonte única, mesma do WhatsApp). */
export const approvalOutcomeOutput = z.object({
  id: z.string(),
  status: approvalStatusOutput,
  applyOutcome: z.enum(["applied", "simulated", "noop", "blocked", "failed"]).nullable(),
  resolvedReason: z.string().nullable(),
  outcomeMessage: z.string().nullable(),
});
export type ApprovalOutcomeOutput = z.infer<typeof approvalOutcomeOutput>;

/**
 * Editar uma ação pendente ANTES de aprovar. Duas formas (uma OU outra):
 *  - ORÇAMENTO (`adjust_budget`): `pct` (increase/decrease em %) OU `budgetReais` (absoluto, mode "set").
 *  - PÚBLICO (`adjust_audience`, Fatia C): `explicitAudience` = substituição TOTAL do público (o editor
 *    do site manda o estado completo, já resolvido keys/ids — mesmo shape dos rascunhos).
 * Pausar/retomar/status não têm o que editar (aprovar/rejeitar). Blast-radius clampado no apply.
 */
export const editApprovalActionInput = z
  .object({
    mode: z.enum(["increase", "decrease", "set"]).optional(),
    pct: z.number().positive().optional(),
    budgetReais: z.number().positive().optional(),
    explicitAudience: explicitAudienceInput.optional(),
  })
  .refine((v) => v.explicitAudience !== undefined || v.mode !== undefined, {
    message: "informe o público (explicitAudience) ou o orçamento (mode + pct/budgetReais)",
  })
  .refine((v) => v.explicitAudience !== undefined || v.mode === undefined || (v.mode === "set" ? v.budgetReais !== undefined : v.pct !== undefined), {
    message: "informe pct (increase/decrease) ou budgetReais (set)",
  });
export type EditApprovalActionInput = z.infer<typeof editApprovalActionInput>;

/**
 * Uma ação aplicada ainda ACIONÁVEL quanto a reverter, cross-conta (dentro do TTL —
 * `undoable` ou `revertBlocked`, nunca as duas false). O revert em si usa a rota
 * por-conta (`POST /accounts/:accountId/agent/actions/:toolCallId/undo`).
 */
export const revertibleActionOutput = z.object({
  toolCallId: z.string(),
  accountId: z.string(),
  accountName: z.string(),
  // `type` = toolKey cru — z.string() de propósito (mesmo motivo do appliedActionOutput).
  type: z.string(),
  targetLevel: z.string(),
  targetId: z.string(),
  targetName: z.string().nullable(),
  undoable: z.boolean(),
  revertBlocked: z.boolean(),
  revertBlockedReason: z.string().nullable(),
});
export type RevertibleActionOutput = z.infer<typeof revertibleActionOutput>;
