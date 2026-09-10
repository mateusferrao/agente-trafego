// Ponte estado→turno da Slice 7 (criativo pelo WhatsApp): o intake de mídia é um side-effect
// (não roda o Grafo B), então guarda uma OFERTA efêmera no Redis (TTL) keyed pela conversa; o
// próximo turno (turn.ts) lê ANTES do grafo e, num "sim" determinístico, resolve — troca o
// criativo do rascunho pendente ('use') ou propõe criar uma campanha com o criativo ('create').
// Não escreve no checkpoint do LangGraph por fora (hacky); a oferta é uma fonte à parte.

import { and, desc, eq } from "drizzle-orm";
import { campaignDrafts } from "@trafego/db";
import type { Database } from "@trafego/db/client";
import type { Redis } from "ioredis";

/** Oferta pendente após o usuário mandar um criativo no WhatsApp. `draftId` presente → há um
 *  rascunho pra USAR o criativo; ausente → oferta de CRIAR uma campanha com ele. */
export interface CreativeOffer {
  readonly assetId: string;
  readonly draftId?: string;
}

/** TTL da oferta (s) — janela curta pro "sim". Some sozinha se o usuário não responder. */
const OFFER_TTL_SECONDS = 30 * 60;
const keyOf = (conversationId: string): string => `creative-offer:${conversationId}`;

export async function setCreativeOffer(redis: Redis, conversationId: string, offer: CreativeOffer): Promise<void> {
  await redis.set(keyOf(conversationId), JSON.stringify(offer), "EX", OFFER_TTL_SECONDS);
}

export async function getCreativeOffer(redis: Redis, conversationId: string): Promise<CreativeOffer | null> {
  const raw = await redis.get(keyOf(conversationId));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as CreativeOffer;
    return parsed.assetId ? parsed : null;
  } catch {
    return null;
  }
}

export async function clearCreativeOffer(redis: Redis, conversationId: string): Promise<void> {
  await redis.del(keyOf(conversationId));
}

/** Rascunho from_scratch ainda aberto da conta → a oferta é USAR o criativo nele (senão CRIAR). */
async function pendingFromScratchDraftId(db: Database, orgId: string, adAccountId: string): Promise<string | null> {
  const [row] = await db
    .select({ id: campaignDrafts.id })
    .from(campaignDrafts)
    .where(
      and(
        eq(campaignDrafts.orgId, orgId),
        eq(campaignDrafts.adAccountId, adAccountId),
        eq(campaignDrafts.status, "proposed"),
        eq(campaignDrafts.kind, "from_scratch"),
      ),
    )
    .orderBy(desc(campaignDrafts.createdAt))
    .limit(1);
  return row?.id ?? null;
}

/**
 * Prepara a oferta de fecho-de-loop de um criativo pronto (imagem no intake / vídeo quando o poll
 * flipa `ready`): resolve se há rascunho aberto pra USAR, grava a oferta no Redis e devolve o
 * `draftId` (ou null = oferta de CRIAR). Fonte única das duas superfícies (intake + poll).
 */
export async function stageCreativeOffer(
  deps: { db: Database; redis: Redis },
  args: { orgId: string; adAccountId: string; assetId: string; conversationId: string },
): Promise<{ draftId: string | null }> {
  const draftId = await pendingFromScratchDraftId(deps.db, args.orgId, args.adAccountId);
  await setCreativeOffer(deps.redis, args.conversationId, { assetId: args.assetId, ...(draftId ? { draftId } : {}) });
  return { draftId };
}

/** Afirmação simples e inequívoca ("sim", "pode", "usa", "cria"…) — determinístico (§8: só o
 *  claro resolve; ambíguo cai no turno normal e a oferta segue no TTL). Curta pra não confundir
 *  uma frase longa (ex: "sim, mas muda o budget") com um OK puro — essa vai pro turno normal. */
const AFFIRM_RE = /^(sim|isso|pode ser|pode|manda|usa|use|cria|criar|quero|vamos|bora|ok|beleza|blz|👍|✅)[\s!.]*$/iu;
export function isSimpleAffirmation(text: string): boolean {
  return AFFIRM_RE.test(text.trim());
}
