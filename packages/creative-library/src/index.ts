// Serviço compartilhado de INGESTÃO de criativo (Fatia 7) — fonte ÚNICA de "bytes de mídia
// → asset reusável". Chamado pelos DOIS caminhos de intake (upload web na API e mídia do
// WhatsApp no worker), pra os dois terem comportamento IDÊNTICO: persistir o blob original
// (StoragePort), subir pra plataforma (image_hash / video_id) e registrar o creative_asset
// dedupado por (conta, storageRef). Depende só de PORTAS + db (desacoplado do canal e do
// provider de storage/ads — trocar local-fs→S3 ou Meta→outro = novo adapter).

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

export interface CreativeVideoIngestDeps {
  readonly db: Database;
  readonly storage: StoragePort;
  readonly ads: Pick<AdsPlatformPort, "uploadVideo">;
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
  /** true = o asset já existia (mesma conta+conteúdo) e foi reusado (não inseriu de novo). */
  readonly deduped: boolean;
}

export interface CreativeVideoIngestResult {
  readonly assetId: string;
  readonly metaVideoId: string;
  readonly storageRef: string;
  readonly deduped: boolean;
  /** vídeo processa async na Meta → nasce `pending` (o poll flipa p/ `ready`); reuso = `ready`. */
  readonly status: "pending" | "ready";
}

/** Asset COMPLETO (status=ready) da conta com o mesmo conteúdo (storageRef). Só rows prontas
 *  qualificam pra reuso — pending/failed (metaVideoId null etc.) NÃO reusa (evita reusar row quebrada). */
async function findReadyAsset(
  db: Database,
  adAccountId: string,
  storageRef: string,
): Promise<{ id: string; metaImageHash: string | null; metaVideoId: string | null } | null> {
  const [existing] = await db
    .select({ id: creativeAssets.id, metaImageHash: creativeAssets.metaImageHash, metaVideoId: creativeAssets.metaVideoId })
    .from(creativeAssets)
    .where(
      and(
        eq(creativeAssets.adAccountId, adAccountId),
        eq(creativeAssets.storageRef, storageRef),
        eq(creativeAssets.status, "ready"),
      ),
    )
    .limit(1);
  return existing ?? null;
}

/**
 * Ingesta uma IMAGEM: grava o blob (StoragePort, content-addressed) → dedup por (conta,
 * storageRef) ANTES de subir (reusa e poupa o upload) → sobe pra plataforma (image_hash) →
 * registra o creative_asset. Idempotente por conteúdo. PURO de canal.
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

  // 2) dedup por (conta, conteúdo): mesmo arquivo JÁ pronto → reusa (poupa o upload à Meta).
  const existing = await findReadyAsset(deps.db, input.adAccountId, stored.ref);
  if (existing?.metaImageHash) {
    return { assetId: existing.id, metaImageHash: existing.metaImageHash, storageRef: stored.ref, deduped: true };
  }

  // 3) sobe pra plataforma → image_hash (o asset FUNCIONAL, reusável em qualquer anúncio).
  const { imageHash } = await deps.ads.uploadImage(input.ref, {
    bytes: input.bytes,
    contentType: input.contentType,
    filename: input.filename,
  });

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

/**
 * Ingesta um VÍDEO: grava o blob → dedup por (conta, storageRef) ANTES de subir → sobe pra
 * plataforma (video_id, processa ASYNC) → registra o asset `pending`. O caller enfileira o poll
 * (getVideoStatus) que flipa p/ `ready`/`error`. Dedup exige row PRONTA (metaVideoId não vaza
 * de um upload que falhou). PURO de canal.
 */
export async function ingestCreativeVideo(
  deps: CreativeVideoIngestDeps,
  input: CreativeIngestInput,
): Promise<CreativeVideoIngestResult> {
  const stored = await deps.storage.put({
    bytes: input.bytes,
    contentType: input.contentType,
    keyPrefix: KEY_PREFIX(input.orgId),
  });

  const existing = await findReadyAsset(deps.db, input.adAccountId, stored.ref);
  if (existing?.metaVideoId) {
    return { assetId: existing.id, metaVideoId: existing.metaVideoId, storageRef: stored.ref, deduped: true, status: "ready" };
  }

  const { videoId } = await deps.ads.uploadVideo(input.ref, {
    bytes: input.bytes,
    contentType: input.contentType,
    filename: input.filename,
  });

  const [row] = await deps.db
    .insert(creativeAssets)
    .values({
      orgId: input.orgId,
      adAccountId: input.adAccountId,
      origin: "upload",
      format: "video",
      status: "pending", // processa async → o poll flipa
      storageRef: stored.ref,
      metaVideoId: videoId,
    })
    .returning({ id: creativeAssets.id });

  return { assetId: row!.id, metaVideoId: videoId, storageRef: stored.ref, deduped: false, status: "pending" };
}
