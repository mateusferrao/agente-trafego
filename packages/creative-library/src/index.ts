// Serviço compartilhado de INGESTÃO de criativo (Fatia 7) — fonte ÚNICA de "bytes de
// imagem → asset reusável". Chamado pelos DOIS caminhos de intake (upload web na API e
// imagem do WhatsApp no worker), pra os dois terem comportamento IDÊNTICO: persistir o
// blob original (StoragePort), subir pra plataforma (image_hash) e registrar o
// creative_asset dedupado por (conta, hash). Depende só de PORTAS + db (desacoplado do
// canal e do provider de storage/ads — trocar local-fs→S3 ou Meta→outro = novo adapter).

import { and, eq } from "drizzle-orm";
import { creativeAssets } from "@trafego/db";
import type { Database } from "@trafego/db/client";
import type { AdAccountRef, AdsPlatformPort, StoragePort } from "@trafego/shared/ports";

/** Namespace lógico do blob no StoragePort (org-scoped). */
const KEY_PREFIX = (orgId: string): string => `org/${orgId}/creatives`;

export interface CreativeIngestDeps {
  readonly db: Database;
  readonly storage: StoragePort;
  readonly ads: Pick<AdsPlatformPort, "uploadImage">;
}

export interface CreativeIngestInput {
  readonly orgId: string;
  /** id INTERNO da conta (uuid) — p/ o registro no banco. */
  readonly adAccountId: string;
  /** referência da conta na plataforma (id externo + token) — p/ o upload. */
  readonly ref: AdAccountRef;
  readonly bytes: Uint8Array;
  readonly contentType: string;
  readonly filename: string;
}

export interface CreativeIngestResult {
  readonly assetId: string;
  readonly metaImageHash: string;
  readonly storageRef: string;
  /** true = o asset já existia (mesma conta+hash) e foi reusado (não inseriu de novo). */
  readonly deduped: boolean;
}

/**
 * Ingesta uma imagem: grava o blob original (StoragePort, content-addressed) → sobe pra
 * plataforma (image_hash) → registra/dedupa o creative_asset. Idempotente por
 * (conta, image_hash): reenvio do mesmo arquivo não duplica a linha. PURO de canal — o
 * caller (web/WhatsApp) resolve conta, permissão e resposta ao usuário.
 */
export async function ingestCreativeImage(
  deps: CreativeIngestDeps,
  input: CreativeIngestInput,
): Promise<CreativeIngestResult> {
  // 1) blob original → StoragePort (ref opaca; sha256 → idempotente por conteúdo).
  const stored = await deps.storage.put({
    bytes: input.bytes,
    contentType: input.contentType,
    keyPrefix: KEY_PREFIX(input.orgId),
  });

  // 2) sobe pra plataforma → image_hash (o asset FUNCIONAL, reusável em qualquer anúncio).
  const { imageHash } = await deps.ads.uploadImage(input.ref, {
    bytes: input.bytes,
    contentType: input.contentType,
    filename: input.filename,
  });

  // 3) dedup por (conta, hash): mesmo arquivo já registrado → reusa (não insere).
  const [existing] = await deps.db
    .select({ id: creativeAssets.id })
    .from(creativeAssets)
    .where(and(eq(creativeAssets.adAccountId, input.adAccountId), eq(creativeAssets.metaImageHash, imageHash)))
    .limit(1);
  if (existing) {
    return { assetId: existing.id, metaImageHash: imageHash, storageRef: stored.ref, deduped: true };
  }

  const [row] = await deps.db
    .insert(creativeAssets)
    .values({
      orgId: input.orgId,
      adAccountId: input.adAccountId,
      origin: "upload",
      format: "image",
      status: "ready",
      storageRef: stored.ref,
      metaImageHash: imageHash,
    })
    .returning({ id: creativeAssets.id });

  return { assetId: row!.id, metaImageHash: imageHash, storageRef: stored.ref, deduped: false };
}
