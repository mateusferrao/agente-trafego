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
 *
 * `approvalKind` (P0.1) distingue os 2 momentos que usam este MESMO card: `draft` = pedindo OK
 * pra CRIAR (gasto novo, ainda não existe na Meta); `activation` = já foi CRIADO pausado
 * (`createdIds` preenchido) e pede OK pra ATIVAR (2º passo HITL — fecha o risco de órfão em
 * crash). O site troca só o texto/CTA por `approvalKind`; o resto do card é o mesmo.
 */
export const draftApprovalOutput = z.object({
  id: z.string(),
  approvalKind: z.enum(["draft", "activation"]),
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
  /** criativo do rascunho (from_scratch) — o card mostra formato/origem + a miniatura
   *  (rota /creative/thumb). `null` em duplicate (clona o anúncio inteiro, sem criativo próprio). */
  creative: z
    .object({
      format: z.enum(["image", "video"]),
      origin: z.enum(["reuse", "upload"]),
    })
    .nullable(),
  /** ids reais criados na Meta — só presente em `approvalKind:"activation"` (já existe na Meta). */
  createdIds: z.record(z.string(), z.unknown()).nullable(),
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

/**
 * Troca o criativo de um rascunho from_scratch (picker "trocar criativo"). União discriminada:
 * `asset` = um upload da biblioteca (uuid de creative_assets); `serving` = reuse de um anúncio
 * AO VIVO da conta (ad id da Meta) — o serviço busca o video_id fresco. Reuse de vídeo cobre o
 * caso comum; imagem ao vivo = fast-follow (falta image_hash).
 */
export const setDraftCreativeInput = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("asset"), assetId: z.string().min(1) }),
  z.object({ kind: z.literal("serving"), adId: z.string().min(1) }),
]);
export type SetDraftCreativeInput = z.infer<typeof setDraftCreativeInput>;
export const setDraftCreativeOutput = z.object({ ok: z.boolean() });
export type SetDraftCreativeOutput = z.infer<typeof setDraftCreativeOutput>;

/** Um anúncio AO VIVO da conta oferecido como candidato de reuse no picker (lê ad_creatives). */
export const servingCreativeOutput = z.object({
  adId: z.string(),
  title: z.string().nullable(),
  copy: z.string().nullable(),
  cta: z.string().nullable(),
  tier: z.string().nullable(),
  /** só vídeo é reusável ao vivo hoje (imagem precisa de image_hash — fast-follow). */
  format: z.enum(["image", "video"]),
  thumbnailUrl: z.string().nullable(),
});
export type ServingCreativeOutput = z.infer<typeof servingCreativeOutput>;
export const servingCreativesListOutput = z.array(servingCreativeOutput);

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

/**
 * Upload de criativo pela web (MULTIPART — imagem + vídeo unificados; o request é multipart,
 * fora do contrato JSON/kubb — a web posta FormData). Só a RESPOSTA é tipada: imagem já vem
 * `ready` (image_hash); vídeo vem `pending` (video_id; o poll flipa depois).
 */
export const uploadCreativeOutput = z.object({
  assetId: z.string(),
  format: z.enum(["image", "video"]),
  status: z.enum(["pending", "ready", "error"]),
  metaImageHash: z.string().nullable(),
  metaVideoId: z.string().nullable(),
});
export type UploadCreativeOutput = z.infer<typeof uploadCreativeOutput>;

/** Args internos da ingestão (o handler multipart resolve os bytes; não é contrato de rede). */
export interface UploadCreativeArgs {
  readonly bytes: Uint8Array;
  readonly contentType: string;
  readonly filename: string;
}
