import { z } from "zod";

const approvalStatusOutput = z.enum(["pending", "approved", "rejected", "expired", "blocked"]);

/** Uma variação de copy (resumo p/ o card de rascunho). */
export const draftCopyVariantOutput = z.object({
  primaryText: z.string(),
  headline: z.string(),
  description: z.string().nullable(),
  cta: z.string().nullable(),
});

/**
 * Aprovação de RASCUNHO de campanha (Fatia 7) — mais rica que 1 ação: estrutura + copy +
 * budget novo + Página/Pixel (card de rascunho, Brand tier). Espelha o card no WhatsApp
 * (eco concreto). Resolve pela MESMA rota (`/approvals/:id/resolve`).
 */
export const draftApprovalOutput = z.object({
  id: z.string(),
  accountId: z.string(),
  accountName: z.string(),
  status: approvalStatusOutput,
  expiresAt: z.string().nullable(),
  draftId: z.string(),
  kind: z.enum(["from_scratch", "duplicate"]),
  origin: z.enum(["on_demand", "proactive"]),
  objective: z.string().nullable(),
  // budget diário em unidade MAIOR da moeda (ex: reais/dólares) — pareado com `currency`
  // p/ o front formatar (nunca hardcodar símbolo). Nome neutro de moeda (não "reais").
  dailyBudgetMajor: z.number(),
  currency: z.string(),
  activation: z.enum(["active", "paused"]),
  /** rótulo da entidade-origem (quando duplicate). */
  sourceLabel: z.string().nullable(),
  pageId: z.string().nullable(),
  pixelId: z.string().nullable(),
  variantsCount: z.number().nullable(),
  copyVariants: z.array(draftCopyVariantOutput).nullable(),
});
export type DraftApprovalOutput = z.infer<typeof draftApprovalOutput>;

export const draftApprovalsListOutput = z.array(draftApprovalOutput);

/** Resposta do usuário ao ASK do passo agressivo (subir seguro vs duplicar). */
export const scaleChoiceInput = z.enum(["raise", "duplicate"]);
export type ScaleChoiceInput = z.infer<typeof scaleChoiceInput>;

/** Pedido de escalar um vencedor pelo site (CTA no card da campanha). `choice` = resposta
 *  do usuário quando o passo agressivo perguntou (ausente na 1ª chamada). */
export const scaleWinnerInput = z.object({
  entityLevel: z.enum(["campaign", "adset"]),
  entityId: z.string().min(1),
  choice: scaleChoiceInput.optional(),
});
export type ScaleWinnerInput = z.infer<typeof scaleWinnerInput>;

/**
 * Resultado de propor a escala (discriminado por `move`):
 * - `raise_budget`/`duplicate` → aprovação criada (`approvalId`);
 * - `ask` → passo agressivo, intent aberto: o site renderiza as 2 opções (subir `raisePct`%
 *   seguro vs duplicar +`duplicatePct`%) e re-chama com `choice`. Nada é criado ainda.
 */
export const scaleWinnerOutput = z.discriminatedUnion("move", [
  z.object({ move: z.literal("raise_budget"), approvalId: z.string() }),
  z.object({ move: z.literal("duplicate"), approvalId: z.string() }),
  z.object({ move: z.literal("ask"), raisePct: z.number(), duplicatePct: z.number() }),
]);
export type ScaleWinnerOutput = z.infer<typeof scaleWinnerOutput>;

/** Troca o criativo de um rascunho from_scratch (picker "trocar criativo"). */
export const setDraftCreativeInput = z.object({ assetId: z.string().min(1) });
export type SetDraftCreativeInput = z.infer<typeof setDraftCreativeInput>;
export const setDraftCreativeOutput = z.object({ ok: z.boolean() });
export type SetDraftCreativeOutput = z.infer<typeof setDraftCreativeOutput>;

/** Um asset da biblioteca de criativos (aba Criativos). */
export const creativeAssetOutput = z.object({
  id: z.string(),
  origin: z.enum(["reuse", "upload"]),
  format: z.enum(["image", "video"]),
  status: z.enum(["pending", "ready", "error"]),
  metaImageHash: z.string().nullable(),
  metaVideoId: z.string().nullable(),
  createdAt: z.string(),
});
export type CreativeAssetOutput = z.infer<typeof creativeAssetOutput>;
export const creativeAssetsListOutput = z.array(creativeAssetOutput);

/** Upload de imagem pela web (base64 — evita dep de multipart; sobe pra Meta → image_hash). */
export const uploadCreativeInput = z.object({
  imageBase64: z.string().min(1),
  contentType: z.string().min(1),
  filename: z.string().min(1),
});
export type UploadCreativeInput = z.infer<typeof uploadCreativeInput>;
export const uploadCreativeOutput = z.object({ assetId: z.string(), metaImageHash: z.string() });
export type UploadCreativeOutput = z.infer<typeof uploadCreativeOutput>;
