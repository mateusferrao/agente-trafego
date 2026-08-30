import { COPY_TEXT_MAX, ENTITY_NAME_MAX, conversionGoalSchema, ctaTypeSchema } from "@trafego/shared";
import { z } from "zod";

const approvalStatusOutput = z.enum(["pending", "approved", "rejected", "expired", "blocked"]);

/** Uma variação de copy (resumo p/ o card + edição no painel). */
export const draftCopyVariantOutput = z.object({
  primaryText: z.string(),
  headline: z.string(),
  description: z.string().nullable(),
  cta: z.string().nullable(),
  /** nome editável do anúncio desta variação (painel "Editar rascunho"). `null` = derivado. */
  adName: z.string().nullable(),
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
  /** budget PEDIDO antes do clamp pelo teto de gasto novo — só quando cortado. O card mostra
   *  "pedi X, virou Y" (transparência §8). `null` quando não houve clamp. */
  clampedFromMajor: z.number().nullable(),
  currency: z.string(),
  activation: z.enum(["active", "paused"]),
  /** entidade-origem (quando duplicate): nível + nome legível. O front monta "conjunto <nome>"
   *  (ou só "o conjunto vencedor" sem nome) — NUNCA o id cru da Meta. */
  sourceLevel: z.enum(["account", "campaign", "adset", "ad"]).nullable(),
  sourceName: z.string().nullable(),
  pageId: z.string().nullable(),
  pixelId: z.string().nullable(),
  /** nomes editáveis (painel). `null` = derivado no apply (`CaquiAI — <objetivo>`). */
  campaignName: z.string().nullable(),
  adsetName: z.string().nullable(),
  /** rótulo do sufixo (só duplicate) — `<vencedor> — <rótulo>`. `null` = "escala". */
  suffixLabel: z.string().nullable(),
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
  /** público do rascunho pelo MODO: `reuse` = herda o conjunto que já converte; `broad` = a Meta
   *  escolhe (amplo). `null` em duplicate/activation E quando o público é explícito/salvo (ver
   *  `explicitAudience` abaixo) — o card oferece alternar entre reuse/broad só nesse caso. */
  audience: z.enum(["reuse", "broad"]).nullable(),
  /** público EXPLÍCITO por primitivos (Fase 1, subfatia 3b) — geo/idade/gênero. `null` quando o
   *  targeting não é `explicit` (os outros modos usam `audience` acima). */
  explicitAudience: z
    .object({
      geo: z.array(z.object({ key: z.string(), name: z.string(), kind: z.enum(["country", "region", "city"]) })),
      ageMin: z.number().nullable(),
      ageMax: z.number().nullable(),
      genders: z.array(z.union([z.literal(1), z.literal(2)])).nullable(),
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
  /** nome legível do vencedor (pro card mostrar o nome, não o id cru); opcional. */
  entityName: z.string().optional(),
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

/** Edição de UMA variação de copy (por índice) no painel "Editar rascunho" (Slice 7). Campos
 *  omitidos = inalterados; texto não-vazio (blank = anúncio sem texto vira estado inválido). */
export const draftCopyEditInput = z.object({
  index: z.number().int().min(0),
  adName: z.string().min(1).max(ENTITY_NAME_MAX).optional(),
  primaryText: z.string().min(1).max(COPY_TEXT_MAX).optional(),
  headline: z.string().min(1).max(COPY_TEXT_MAX).optional(),
  description: z.string().max(COPY_TEXT_MAX).optional(),
  cta: ctaTypeSchema.optional(),
});

/**
 * Edição CONSOLIDADA de um rascunho (painel "Editar rascunho", Slice 7) — só os campos ALTERADOS.
 * Converge com o chat no núcleo `applyDraftEdit` (§13 DRY). `objective` + geração de copy por IA =
 * 7b (exigem re-resolução de pixel + porta LLM). Escala aceita só `suffixLabel`/budget/activation.
 */
export const updateDraftInput = z.object({
  budgetReais: z.number().positive().optional(),
  activation: z.enum(["active", "paused"]).optional(),
  campaignName: z.string().min(1).max(ENTITY_NAME_MAX).optional(),
  adsetName: z.string().min(1).max(ENTITY_NAME_MAX).optional(),
  /** conversão de negócio (só from_scratch) — o backend re-resolve o pixel da conta e bloqueia se
   *  o objetivo exige pixel e a conta não tem (§13 mensagem amigável). */
  objective: conversionGoalSchema.optional(),
  suffixLabel: z.string().min(1).max(ENTITY_NAME_MAX).optional(),
  audience: z.enum(["reuse", "broad"]).optional(),
  creative: setDraftCreativeInput.optional(),
  copyEdits: z.array(draftCopyEditInput).optional(),
  removeAdIndex: z.number().int().min(0).optional(),
  // ─── público EXPLÍCITO (Fase 1, subfatia 3b) — só quando o rascunho já é `kind:"explicit"` ───
  /** nomes EXATOS (como renderizados nos chips) a remover — sem ambiguidade (o usuário clicou o chip). */
  removeGeo: z.array(z.string().min(1)).optional(),
  /** já RESOLVIDO pelo autocomplete (geo-search) — o site nunca manda nome livre pro backend resolver. */
  addGeo: z.array(z.object({ key: z.string().min(1), name: z.string().min(1), kind: z.enum(["country", "region", "city"]) })).optional(),
  ageMin: z.number().int().min(13).max(65).optional(),
  ageMax: z.number().int().min(13).max(65).optional(),
});
export type UpdateDraftInput = z.infer<typeof updateDraftInput>;
export const updateDraftOutput = z.object({ ok: z.boolean() });
export type UpdateDraftOutput = z.infer<typeof updateDraftOutput>;

/** Alterna o público do rascunho: `reuse` = herda o conjunto provado; `broad` = Meta escolhe. */
export const setDraftTargetingInput = z.object({ audience: z.enum(["reuse", "broad"]) });
export type SetDraftTargetingInput = z.infer<typeof setDraftTargetingInput>;
export const setDraftTargetingOutput = z.object({ ok: z.boolean(), audience: z.enum(["reuse", "broad"]) });
export type SetDraftTargetingOutput = z.infer<typeof setDraftTargetingOutput>;

/** Busca de geo (Fase 1, subfatia 3b) — autocomplete de cidade/região/país no editor de rascunho. */
export const geoSearchQuery = z.object({ q: z.string().min(1) });
export type GeoSearchQuery = z.infer<typeof geoSearchQuery>;
export const geoSearchResultOutput = z.object({
  key: z.string(),
  name: z.string(),
  kind: z.enum(["country", "region", "city"]),
  countryCode: z.string().nullable(),
});
export type GeoSearchResultOutput = z.infer<typeof geoSearchResultOutput>;

/** Um anúncio AO VIVO da conta oferecido como candidato de reuse no picker (lê ad_creatives). */
export const servingCreativeOutput = z.object({
  adId: z.string(),
  title: z.string().nullable(),
  copy: z.string().nullable(),
  cta: z.string().nullable(),
  tier: z.string().nullable(),
  /** vídeo (video_id) OU imagem (image_hash) — ambos reusáveis ao vivo (Slice 12). */
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
