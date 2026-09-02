// Serviço compartilhado de INGESTÃO de criativo (Fatia 7) — fonte ÚNICA de "bytes de mídia
// → asset reusável". Chamado pelos DOIS caminhos de intake (upload web na API e mídia do
// WhatsApp no worker), pra os dois terem comportamento IDÊNTICO: persistir o blob original
// (StoragePort), subir pra plataforma (image_hash / video_id) e registrar o creative_asset
// dedupado por (conta, storageRef). Depende só de PORTAS + db (desacoplado do canal e do
// provider de storage/ads — trocar local-fs→S3 ou Meta→outro = novo adapter).

import { and, eq, sql } from "drizzle-orm";
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

interface ExistingAssetRow {
  readonly id: string;
  readonly status: "pending" | "ready" | "error";
  readonly metaImageHash: string | null;
  readonly metaVideoId: string | null;
  readonly archivedAt: Date | null;
}

/**
 * Asset existente da conta com o MESMO conteúdo (storageRef), EM QUALQUER status. Com o unique
 * constraint parcial `(ad_account_id, storage_ref) WHERE storage_ref IS NOT NULL` (P0.2), só pode
 * existir 0 ou 1 linha por (conta, storageRef) — não filtra mais por status na query: a decisão
 * de reusar/limpar/reativar é do CALLER (varia por formato: vídeo `pending` é reusável, `error` não).
 */
async function findExistingAsset(db: Database, adAccountId: string, storageRef: string): Promise<ExistingAssetRow | null> {
  const [existing] = await db
    .select({
      id: creativeAssets.id,
      status: creativeAssets.status,
      metaImageHash: creativeAssets.metaImageHash,
      metaVideoId: creativeAssets.metaVideoId,
      archivedAt: creativeAssets.archivedAt,
    })
    .from(creativeAssets)
    .where(and(eq(creativeAssets.adAccountId, adAccountId), eq(creativeAssets.storageRef, storageRef)))
    .limit(1);
  return existing ?? null;
}

/** Re-upload do MESMO conteúdo já ARQUIVADO = "quero de volta na biblioteca" — reativa (limpa
 *  `archivedAt`) em vez de devolver silenciosamente um asset que segue escondido do picker. */
async function reactivateIfArchived(db: Database, existing: ExistingAssetRow): Promise<void> {
  if (existing.archivedAt) {
    await db.update(creativeAssets).set({ archivedAt: null }).where(eq(creativeAssets.id, existing.id));
  }
}

/** Um asset em `error` (ex: Meta rejeitou o vídeo) não é reusável — mas OCUPA o slot do unique
 *  constraint, então reenviar o MESMO conteúdo precisa poder tentar de novo. Limpa a linha morta
 *  antes de inserir a nova tentativa (self-heal; sem isto o retry ficaria preso pra sempre). */
async function clearIfErrored(db: Database, existing: ExistingAssetRow | null): Promise<void> {
  if (existing?.status === "error") {
    await db.delete(creativeAssets).where(eq(creativeAssets.id, existing.id));
  }
}

/** Predicado da ON CONFLICT — tem que casar EXATAMENTE com o `WHERE` do índice único parcial
 *  (`creative_assets_account_storage_uq`), senão o Postgres não acha o índice a mirar. */
const STORAGE_REF_CONFLICT_TARGET = {
  target: [creativeAssets.adAccountId, creativeAssets.storageRef],
  where: sql`${creativeAssets.storageRef} is not null`,
};

/**
 * Ingesta uma IMAGEM: grava o blob (StoragePort, content-addressed) → dedup por (conta,
 * storageRef) ANTES de subir (reusa e poupa o upload) → sobe pra plataforma (image_hash) →
 * insere com `onConflictDoNothing` no unique constraint (P0.2) — se outro upload IDÊNTICO
 * venceu a corrida entre o select e o insert, reusa a linha dele em vez de duplicar. PURO de canal.
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

  // 2) fast-path: mesmo arquivo já PRONTO → reusa (poupa o upload à Meta); reativa se arquivado.
  const existing = await findExistingAsset(deps.db, input.adAccountId, stored.ref);
  if (existing?.status === "ready" && existing.metaImageHash) {
    await reactivateIfArchived(deps.db, existing);
    return { assetId: existing.id, metaImageHash: existing.metaImageHash, storageRef: stored.ref, deduped: true };
  }
  await clearIfErrored(deps.db, existing);

  // 3) sobe pra plataforma → image_hash (o asset FUNCIONAL, reusável em qualquer anúncio).
  const { imageHash } = await deps.ads.uploadImage(input.ref, {
    bytes: input.bytes,
    contentType: input.contentType,
    filename: input.filename,
  });

  const inserted = await deps.db
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
    .onConflictDoNothing(STORAGE_REF_CONFLICT_TARGET)
    .returning({ id: creativeAssets.id });

  if (inserted[0]) {
    return { assetId: inserted[0].id, metaImageHash: imageHash, storageRef: stored.ref, deduped: false };
  }

  // 4) conflito real: outro upload do MESMO conteúdo venceu a corrida entre o select (passo 2) e
  // este insert. O upload que ESTE chamador fez à Meta (passo 3) fica órfão lá — benigno, não é
  // referenciado, não custa nada além da chamada já feita. Reusa a linha vencedora.
  const winner = await findExistingAsset(deps.db, input.adAccountId, stored.ref);
  if (!winner?.metaImageHash) {
    throw new Error("ingestCreativeImage: conflito de dedup sem asset resolvível (linha concorrente incompleta)");
  }
  await reactivateIfArchived(deps.db, winner);
  return { assetId: winner.id, metaImageHash: winner.metaImageHash, storageRef: stored.ref, deduped: true };
}

/**
 * Ingesta um VÍDEO: grava o blob → dedup por (conta, storageRef) ANTES de subir → sobe pra
 * plataforma (video_id, processa ASYNC) → insere com `onConflictDoNothing` (P0.2). Dedup reusa
 * `ready` OU `pending` (evita re-upload + 2ª poll chain da MESMA corrida); `error` não reusa —
 * self-heal (limpa a linha morta). Conflito real na corrida → reusa o vencedor. PURO de canal.
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

  const existing = await findExistingAsset(deps.db, input.adAccountId, stored.ref);
  if (existing && existing.metaVideoId && (existing.status === "ready" || existing.status === "pending")) {
    await reactivateIfArchived(deps.db, existing);
    return {
      assetId: existing.id,
      metaVideoId: existing.metaVideoId,
      storageRef: stored.ref,
      deduped: true,
      status: existing.status === "ready" ? "ready" : "pending",
    };
  }
  if (existing && existing.status !== "error") {
    // ocupa o slot mas não tem id usável nem é 'error' (self-heal só se aplica a erro conhecido) —
    // estado anômalo que nunca deveria acontecer (o insert sempre grava o id junto do status).
    throw new Error("ingestCreativeVideo: conflito de dedup sem asset resolvível (linha concorrente incompleta)");
  }
  await clearIfErrored(deps.db, existing);

  const { videoId } = await deps.ads.uploadVideo(input.ref, {
    bytes: input.bytes,
    contentType: input.contentType,
    filename: input.filename,
  });

  const inserted = await deps.db
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
    .onConflictDoNothing(STORAGE_REF_CONFLICT_TARGET)
    .returning({ id: creativeAssets.id });

  if (inserted[0]) {
    return { assetId: inserted[0].id, metaVideoId: videoId, storageRef: stored.ref, deduped: false, status: "pending" };
  }

  const winner = await findExistingAsset(deps.db, input.adAccountId, stored.ref);
  if (!winner?.metaVideoId) {
    throw new Error("ingestCreativeVideo: conflito de dedup sem asset resolvível (linha concorrente incompleta)");
  }
  await reactivateIfArchived(deps.db, winner);
  return {
    assetId: winner.id,
    metaVideoId: winner.metaVideoId,
    storageRef: stored.ref,
    deduped: true,
    status: winner.status === "ready" ? "ready" : "pending",
  };
}
