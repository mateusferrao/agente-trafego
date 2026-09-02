// Worker BullMQ da fila `creative-analyze` (biblioteca): analisa por VISÃO cada criativo
// subido — UMA vez — e cacheia a descrição (reusa o MESMO resolver + a tabela
// creative_vision_analyses dos anúncios veiculados). Imagem = nosso blob (data-url, zero call
// Meta); vídeo = frames HD da Meta (video_id). Enfileirado no upload (imagem) e quando o poll
// flipa o vídeo pra `ready`. Idempotente pelo cache do resolver (contentHash estável por asset).

import { Worker } from "bullmq";
import { and, eq } from "drizzle-orm";
import { creativeAssets } from "@trafego/db";
import { CREATIVE_ANALYZE_QUEUE, type CreativeAnalyzePayload } from "@trafego/shared";
import type { AdAccountRef } from "@trafego/shared/ports";
import type { Redis } from "ioredis";
import type { WorkerDeps } from "../composition.js";
import { createAnalysisRepo } from "../modules/analysis/repo.js";
import { createVisionResolver, creativeContentHash } from "../modules/vision/resolver.js";

/** Chave de cache (visão) de um asset da biblioteca — estável por id, sem copy. Reusada por
 *  quem for LER a descrição depois (pick/UI). */
export function libraryCreativeContentHash(assetId: string): string {
  return creativeContentHash(assetId, undefined);
}

function toDataUrl(bytes: Uint8Array, contentType: string): string {
  return `data:${contentType};base64,${Buffer.from(bytes).toString("base64")}`;
}

export function startCreativeAnalyzeWorker(deps: WorkerDeps, connection: Redis): Worker<CreativeAnalyzePayload> {
  const { db, ports, logger } = deps;
  const repo = createAnalysisRepo(db);
  const vision = createVisionResolver({
    db,
    llm: ports.llm,
    model: deps.analysis.visionModel,
    analyzerVersion: deps.visionAnalyzerVersion,
    logger,
  });

  return new Worker<CreativeAnalyzePayload>(
    CREATIVE_ANALYZE_QUEUE,
    async (job) => {
      const p = job.data;
      const [asset] = await db
        .select({
          format: creativeAssets.format,
          status: creativeAssets.status,
          archivedAt: creativeAssets.archivedAt,
          storageRef: creativeAssets.storageRef,
          metaVideoId: creativeAssets.metaVideoId,
        })
        .from(creativeAssets)
        .where(and(eq(creativeAssets.id, p.assetId), eq(creativeAssets.orgId, p.orgId), eq(creativeAssets.adAccountId, p.adAccountId)))
        .limit(1);
      if (!asset || asset.status !== "ready" || asset.archivedAt) {
        logger.debug({ assetId: p.assetId }, "creative-analyze:asset não pronto/arquivado — pulo");
        return;
      }

      // mídia p/ a visão: imagem = nosso blob (data-url, sem tocar a Meta); vídeo = frames Meta.
      let imageUrls: string[] = [];
      if (asset.format === "image" && asset.storageRef) {
        const blob = await ports.storage.get(asset.storageRef);
        if (blob) imageUrls = [toDataUrl(blob.bytes, blob.contentType)];
      } else if (asset.format === "video" && asset.metaVideoId) {
        const account = await repo.loadAccount(p.orgId, p.adAccountId);
        if (account) {
          const ref: AdAccountRef = { adAccountId: account.metaAdAccountId, accessToken: ports.vault.decrypt(account.tokenCripto) };
          try {
            imageUrls = await ports.ads.getVideoFrames(ref, asset.metaVideoId);
          } catch (err) {
            logger.warn({ assetId: p.assetId, err: String(err) }, "creative-analyze:frames de vídeo falharam");
          }
        }
      }
      if (imageUrls.length === 0) {
        logger.warn({ assetId: p.assetId, format: asset.format }, "creative-analyze:sem mídia p/ visão — pulo");
        return;
      }

      // resolve → cacheia em creative_vision_analyses (idempotente por contentHash+versão).
      const result = await vision.resolve({ creativeId: p.assetId, imageUrls, contentHash: libraryCreativeContentHash(p.assetId) });
      logger.info({ assetId: p.assetId, format: asset.format, ok: Boolean(result) }, "creative-analyze:concluído");
    },
    { connection },
  );
}
