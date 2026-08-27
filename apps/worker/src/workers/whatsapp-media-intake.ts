// Worker BullMQ da fila `whatsapp-media-intake` (Fatia 7): transforma uma imagem
// recebida no WhatsApp num asset de criativo reusável.
//
// Fluxo: resolve a conta em foco da conversa → resolve os bytes (inline ou
// `fetchMediaBase64`) → grava o blob original no StoragePort → sobe pra Meta
// (image_hash) → registra o `creative_asset` (origin=upload) → responde "recebi,
// guardei". Imagem NUNCA dispara turno do Grafo B (é side-effect + cortesia).
//
// Ban-safety/§9: só chega aqui inbound JÁ autorizado (DM de contato verificado ou
// grupo dirigido — o router de inbound filtrou). O blob trafega por REF do
// StoragePort, nunca no payload da fila.

import { Worker } from "bullmq";
import {
  WHATSAPP_MEDIA_INTAKE_QUEUE,
  type WhatsappMediaIntakePayload,
} from "@trafego/shared";
import type { AdAccountRef, AdsPlatformPort, CredentialVaultPort, MessagingChannelPort, StoragePort } from "@trafego/shared/ports";
import type { Redis } from "ioredis";
import type { Logger } from "pino";
import { and, eq } from "drizzle-orm";
import { creativeAssets } from "@trafego/db/schema";
import type { Database } from "@trafego/db/client";
import type { WorkerDeps } from "../composition.js";
import { createAnalysisRepo } from "../modules/analysis/repo.js";
import { createNotifyRepo, type NotifyRepo } from "../modules/notify/repo.js";
import { createSendToConversation, type SendToConversation } from "../modules/notify/send-to-contact.js";

/** Mensagens de cortesia do intake — sempre o que aconteceu + próximo passo (§13 UX). */
const NOTICE = {
  noAccount: "recebi sua imagem! só me diz de qual conta ela é (você tem mais de uma) que eu guardo na biblioteca de criativos.",
  noBytes: "não consegui baixar a imagem — pode mandar de novo?",
  failed: "recebi a imagem mas tive um problema pra guardar — pode tentar de novo em instantes?",
  saved: (accountName: string) =>
    `imagem guardada na biblioteca de criativos${accountName ? ` da ${accountName}` : ""} — já dá pra usar num rascunho de campanha.`,
} as const;

/** Extensão default por content-type (nomeia o arquivo no upload pra Meta). */
const EXT_BY_TYPE: Readonly<Record<string, string>> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
};

/** Deps enxutas do intake → testável sem BullMQ. */
export interface MediaIntakeDeps {
  readonly db: Database;
  readonly repo: Pick<NotifyRepo, "contextAdAccountId">;
  readonly analysisRepo: Pick<ReturnType<typeof createAnalysisRepo>, "loadAccount">;
  readonly ports: {
    readonly ads: Pick<AdsPlatformPort, "uploadImage">;
    readonly messaging: Pick<MessagingChannelPort, "fetchMediaBase64">;
    readonly vault: Pick<CredentialVaultPort, "decrypt">;
    readonly storage: StoragePort;
  };
  readonly sendToConversation: SendToConversation;
  readonly logger: Pick<Logger, "debug" | "warn">;
}

/**
 * Processa uma imagem recebida: grava, sobe pra Meta, registra o asset e confirma.
 * Puro de BullMQ (deps injetadas). Erros de IO (fetch/upload) sobem → BullMQ re-tenta;
 * casos de negócio (sem conta / sem bytes) respondem cortesia e encerram (sem retry).
 */
export function makeMediaIntake(d: MediaIntakeDeps) {
  return async function intake(payload: WhatsappMediaIntakePayload): Promise<void> {
    const { orgId, conversationId, ref, instanceId, image } = payload;

    // 1) conta em foco (única ativa OU foco da conversa). Ambíguo → pede antes de subir.
    const adAccountUuid = await d.repo.contextAdAccountId(orgId, conversationId);
    if (!adAccountUuid) {
      await d.sendToConversation(ref, NOTICE.noAccount, { split: true, quoteLastInbound: true });
      d.logger.debug({ conversationId }, "intake:no_focused_account");
      return;
    }

    const account = await d.analysisRepo.loadAccount(orgId, adAccountUuid);
    if (!account) {
      await d.sendToConversation(ref, NOTICE.noBytes, { split: true });
      d.logger.warn({ conversationId, adAccountUuid }, "intake:account_unavailable");
      return;
    }

    // 2) bytes: inline (webhook base64:true) ou fallback por chave (fetchMediaBase64).
    const base64 =
      image.base64.length > 0
        ? image.base64
        : (await d.ports.messaging.fetchMediaBase64({ instanceId }, image.messageKey)) ?? "";
    if (base64.length === 0) {
      await d.sendToConversation(ref, NOTICE.noBytes, { split: true, quoteLastInbound: true });
      d.logger.warn({ conversationId }, "intake:no_bytes");
      return;
    }
    const bytes = new Uint8Array(Buffer.from(base64, "base64"));

    try {
      // 3) blob original → StoragePort (ref opaca; nunca na fila).
      const stored = await d.ports.storage.put({
        bytes,
        contentType: image.mimetype,
        keyPrefix: `org/${orgId}/creatives`,
      });

      // 4) sobe pra Meta (image_hash) — conta + token frescos.
      const accessToken = d.ports.vault.decrypt(account.tokenCripto);
      const accountRef: AdAccountRef = { adAccountId: account.metaAdAccountId, accessToken };
      const ext = EXT_BY_TYPE[image.mimetype] ?? "jpg";
      const filename = image.caption ? `${image.caption}.${ext}` : `whatsapp-${Date.now()}.${ext}`;
      const { imageHash } = await d.ports.ads.uploadImage(accountRef, { bytes, contentType: image.mimetype, filename });

      // 5) registra o asset (idempotente por image_hash + conta: reenvio não duplica).
      const [existing] = await d.db
        .select({ id: creativeAssets.id })
        .from(creativeAssets)
        .where(and(eq(creativeAssets.adAccountId, adAccountUuid), eq(creativeAssets.metaImageHash, imageHash)))
        .limit(1);
      if (!existing) {
        await d.db.insert(creativeAssets).values({
          orgId,
          adAccountId: adAccountUuid,
          origin: "upload",
          format: "image",
          status: "ready",
          storageRef: stored.ref,
          metaImageHash: imageHash,
        });
      }

      await d.sendToConversation(ref, NOTICE.saved(account.name), { split: true, quoteLastInbound: true });
      d.logger.debug({ conversationId, imageHash }, "intake:saved");
    } catch (err) {
      // Falha de IO: avisa e RE-LANÇA → BullMQ re-tenta com backoff (upload/storage transitórios).
      await d.sendToConversation(ref, NOTICE.failed, { split: true }).catch(() => undefined);
      throw err;
    }
  };
}

/** Start do worker (composition injeta deps). */
export function startWhatsappMediaIntakeWorker(deps: WorkerDeps, connection: Redis): Worker {
  const { db, ports, logger } = deps;
  const repo = createNotifyRepo(db);
  const intake = makeMediaIntake({
    db,
    repo,
    analysisRepo: createAnalysisRepo(db),
    ports: { ads: ports.ads, messaging: ports.messaging, vault: ports.vault, storage: ports.storage },
    sendToConversation: createSendToConversation({ messaging: ports.messaging, repo }),
    logger,
  });

  return new Worker<WhatsappMediaIntakePayload>(
    WHATSAPP_MEDIA_INTAKE_QUEUE,
    async (job) => {
      await intake(job.data);
    },
    { connection },
  );
}
