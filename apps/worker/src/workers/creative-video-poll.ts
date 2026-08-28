// Worker BullMQ da fila `creative-video-poll` (Fatia 7): vídeo processa ASYNC na plataforma.
// O intake insere o asset `pending` + enfileira este job, que consulta getVideoStatus e
// RE-ENFILEIRA com delay enquanto `processing` → flipa `ready`/`error`. Cadeia auto-limitada
// pelo attempt cap (nunca fica pending pra sempre pela via normal); crash que perde a cadeia é
// coberto pelo reaper (sweep de `pending` órfão). Web/WhatsApp compartilham o mesmo poll.

import { Worker } from "bullmq";
import { and, eq, lt } from "drizzle-orm";
import { creativeAssets } from "@trafego/db";
import type { Database } from "@trafego/db/client";
import type { Logger } from "pino";
import {
  CREATIVE_VIDEO_POLL_MAX_ATTEMPTS,
  CREATIVE_VIDEO_POLL_QUEUE,
  buildCreativeAnalyzeJob,
  buildCreativeVideoPollJob,
  type CreativeVideoPollPayload,
} from "@trafego/shared";
import type { AdAccountRef } from "@trafego/shared/ports";
import type { Redis } from "ioredis";
import type { WorkerDeps } from "../composition.js";
import { createAnalysisRepo } from "../modules/analysis/repo.js";

/** Idade (min) além da qual um vídeo `pending` é considerado órfão (crash perdeu a cadeia de
 *  poll). Folga acima do cap do poll (~16min) — >30min pending = travado de verdade. */
const STALE_PENDING_MINUTES = 30;

/**
 * Reaper (rede de segurança): marca `error` os vídeos `pending` velhos demais — cobre o crash
 * que perdeu a cadeia de poll (a cadeia normal se auto-limita pelo attempt cap). Rodado no boot
 * do worker (limpa presos de um crash anterior). Idempotente. Retorna quantos marcou.
 */
export async function reapStalePendingVideos(db: Database, logger: Logger): Promise<number> {
  const cutoff = new Date(Date.now() - STALE_PENDING_MINUTES * 60_000);
  const rows = await db
    .update(creativeAssets)
    .set({ status: "error" })
    .where(and(eq(creativeAssets.status, "pending"), eq(creativeAssets.format, "video"), lt(creativeAssets.createdAt, cutoff)))
    .returning({ id: creativeAssets.id });
  if (rows.length > 0) logger.warn({ count: rows.length }, "creative-video-poll:reaper marcou pending órfão → error");
  return rows.length;
}

export function startCreativeVideoPollWorker(deps: WorkerDeps, connection: Redis): Worker<CreativeVideoPollPayload> {
  const { db, ports, logger } = deps;
  const scheduler = ports.scheduler;
  const repo = createAnalysisRepo(db);

  const setStatus = (assetId: string, orgId: string, status: "ready" | "error"): Promise<unknown> =>
    db.update(creativeAssets).set({ status }).where(and(eq(creativeAssets.id, assetId), eq(creativeAssets.orgId, orgId)));

  const reenqueueOrGiveUp = async (p: CreativeVideoPollPayload): Promise<void> => {
    if (p.attempt < CREATIVE_VIDEO_POLL_MAX_ATTEMPTS) {
      await scheduler.enqueue(buildCreativeVideoPollJob({ ...p, attempt: p.attempt + 1 }));
    } else {
      logger.warn({ assetId: p.assetId }, "creative-video-poll:cap atingido → error");
      await setStatus(p.assetId, p.orgId, "error");
    }
  };

  return new Worker<CreativeVideoPollPayload>(
    CREATIVE_VIDEO_POLL_QUEUE,
    async (job) => {
      const p = job.data;
      const account = await repo.loadAccount(p.orgId, p.adAccountId);
      if (!account) {
        // conta sumiu (removida) → não insiste; o reaper marca o pending órfão depois.
        logger.warn({ assetId: p.assetId, adAccountId: p.adAccountId }, "creative-video-poll:conta indisponível");
        return;
      }
      const ref: AdAccountRef = {
        adAccountId: account.metaAdAccountId,
        accessToken: ports.vault.decrypt(account.tokenCripto),
      };

      let status: "ready" | "processing" | "error";
      try {
        ({ status } = await ports.ads.getVideoStatus(ref, p.metaVideoId));
      } catch (err) {
        // erro transiente (rate-limit/rede) → re-tenta enquanto cabe no cap.
        logger.debug({ err: String(err), assetId: p.assetId }, "creative-video-poll:getVideoStatus falhou (retenta)");
        await reenqueueOrGiveUp(p);
        return;
      }

      if (status === "ready") {
        await setStatus(p.assetId, p.orgId, "ready");
        // vídeo pronto → analisa a visão 1x (frames Meta) + cacheia p/ a biblioteca.
        await scheduler.enqueue(buildCreativeAnalyzeJob({ orgId: p.orgId, adAccountId: p.adAccountId, assetId: p.assetId }));
        logger.info({ assetId: p.assetId }, "creative-video-poll:pronto");
        return;
      }
      if (status === "error") {
        await setStatus(p.assetId, p.orgId, "error");
        return;
      }
      await reenqueueOrGiveUp(p); // processing → continua
    },
    { connection },
  );
}
