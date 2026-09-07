// Worker BullMQ da fila `whatsapp-media-intake` (Fatia 7): transforma uma imagem
// recebida no WhatsApp num asset de criativo reusável.
//
// Fluxo: resolve a conta em foco da conversa → resolve os bytes (inline ou
// `fetchMediaBase64`) → grava o blob original no StoragePort → sobe pra Meta
// (image_hash) → registra o `creative_asset` (origin=upload) → responde "recebi,
// guardei". Imagem NUNCA dispara turno do Grafo B (é side-effect + cortesia).
//
// Ban-safety/§9: só chega aqui inbound JÁ autorizado (DM de contato verificado ou
// grupo dirigido — o router de inbound filtrou). A partir do StoragePort o blob vive
// por REF (nunca em log); na FILA os bytes podem vir inline (mesmo padrão do áudio na
// transcrição) quando o webhook os entregou — fica no Redis interno, fora de log.

import { Worker } from "bullmq";
import {
  WHATSAPP_MEDIA_INTAKE_ATTEMPTS,
  WHATSAPP_MEDIA_INTAKE_QUEUE,
  buildCreativeAnalyzeJob,
  buildCreativeVideoPollJob,
  type WhatsappMediaIntakePayload,
} from "@trafego/shared";
import type {
  AdAccountRef,
  AdsPlatformPort,
  CredentialVaultPort,
  MessagingChannelPort,
  SchedulerPort,
  StoragePort,
} from "@trafego/shared/ports";
import type { Redis } from "ioredis";
import type { Logger } from "pino";
import { ingestCreativeImage, ingestCreativeVideo } from "@trafego/creative-library";
import type { Database } from "@trafego/db/client";
import type { WorkerDeps } from "../composition.js";
import { createAnalysisRepo } from "../modules/analysis/repo.js";
import { createNotifyRepo, type NotifyRepo } from "../modules/notify/repo.js";
import { createSendToConversation, type SendToConversation } from "../modules/notify/send-to-contact.js";
import { stageCreativeOffer } from "../modules/conversation/creative-offer.js";

/** Mensagens de cortesia do intake — sempre o que aconteceu + próximo passo (§13 UX). */
const NOTICE = {
  noAccount: "Recebi seu criativo! Só me diz de qual conta ele é (você tem mais de uma) que eu guardo na biblioteca de criativos.",
  accountUnavailable: "Recebi seu criativo, mas não consegui acessar essa conta agora — tenta de novo daqui a pouco?",
  noBytes: "Não consegui baixar o arquivo — pode mandar de novo?",
  failed: "Recebi o arquivo mas tive um problema pra guardar — pode tentar de novo em instantes?",
  videoTooLarge: (maxMb: number) =>
    `Esse vídeo é grande demais pra eu receber por aqui (limite ${maxMb}MB) — sobe ele pela biblioteca de criativos no site.`,
  saved: (accountName: string) =>
    `Imagem guardada na biblioteca de criativos${accountName ? ` da ${accountName}` : ""} — já dá pra usar num rascunho de campanha.`,
  // v1 (escrita conversacional OFF): salva na biblioteca, sem oferta de criar/trocar por chat —
  // o uso do criativo num rascunho é na plataforma (site).
  savedLibraryOnly: (accountName: string) =>
    `Imagem guardada na biblioteca de criativos${accountName ? ` da ${accountName}` : ""} — dá pra usar num rascunho de campanha pela plataforma (site).`,
  savedOfferUse: () =>
    `Imagem guardada! Quer que eu use ela no rascunho de campanha que te propus? Responde *sim* que eu troco o criativo.`,
  savedOfferCreate: (accountName: string) =>
    `Imagem guardada${accountName ? ` na ${accountName}` : ""}! Quer que eu crie uma campanha com ela? Responde *sim* que eu monto o rascunho.`,
  videoSaved: (accountName: string) =>
    `Vídeo recebido${accountName ? ` na ${accountName}` : ""} — tô processando; ele fica pronto pra usar num rascunho em instantes.`,
} as const;

/** Extensão default por content-type (nomeia o arquivo no upload pra Meta). */
const EXT_BY_TYPE: Readonly<Record<string, string>> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
  "video/mp4": "mp4",
  "video/quicktime": "mov",
};

/** Deps enxutas do intake → testável sem BullMQ. */
export interface MediaIntakeDeps {
  readonly db: Database;
  readonly repo: Pick<NotifyRepo, "contextAdAccountId">;
  readonly analysisRepo: Pick<ReturnType<typeof createAnalysisRepo>, "loadAccount">;
  readonly ports: {
    readonly ads: Pick<AdsPlatformPort, "uploadImage" | "uploadVideo">;
    readonly messaging: Pick<MessagingChannelPort, "fetchMediaBase64">;
    readonly vault: Pick<CredentialVaultPort, "decrypt">;
    readonly storage: StoragePort;
    /** enfileira o poll de status de vídeo (upload async). */
    readonly scheduler: Pick<SchedulerPort, "enqueue">;
  };
  /** teto de tamanho do vídeo no WhatsApp (bytes vão pra memória do worker → OOM se grande). */
  readonly maxWhatsappVideoBytes: number;
  readonly sendToConversation: SendToConversation;
  /** guarda a OFERTA (usar no rascunho / criar) pro próximo turno resolver (ponte estado→turno). */
  readonly redis: Redis;
  /** escrita conversacional de ads (v1: default OFF). OFF → salva na biblioteca SEM oferta de
   *  criar/trocar por chat (usar o criativo num rascunho é na plataforma). */
  readonly chatAdsWrites: boolean;
  readonly logger: Pick<Logger, "debug" | "warn">;
}

/**
 * Processa uma imagem recebida: grava, sobe pra Meta, registra o asset e confirma.
 * Puro de BullMQ (deps injetadas). Erros de IO (fetch/upload) sobem → BullMQ re-tenta;
 * casos de negócio (sem conta / sem bytes) respondem cortesia e encerram (sem retry).
 */
export function makeMediaIntake(d: MediaIntakeDeps) {
  return async function intake(payload: WhatsappMediaIntakePayload, notifyOnFailure = true): Promise<void> {
    const { orgId, conversationId, ref, instanceId, mediaType, media } = payload;
    // B3: imagem com legenda → o turno do Grafo B responde; o intake salva em SILÊNCIO (sem
    // cortesia/oferta próprias) pra não duplicar a resposta. As respostas passam por `notify`.
    const notify: SendToConversation = payload.suppressNotice ? async () => true : d.sendToConversation;

    // 1) conta em foco (única ativa OU foco da conversa). Ambíguo → pede antes de subir.
    const adAccountUuid = await d.repo.contextAdAccountId(orgId, conversationId);
    if (!adAccountUuid) {
      await notify(ref, NOTICE.noAccount, { split: true, quoteLastInbound: true });
      d.logger.debug({ conversationId }, "intake:no_focused_account");
      return;
    }

    const account = await d.analysisRepo.loadAccount(orgId, adAccountUuid);
    if (!account) {
      await notify(ref, NOTICE.accountUnavailable, { split: true });
      d.logger.warn({ conversationId, adAccountUuid }, "intake:account_unavailable");
      return;
    }

    // 2) PROBE de tamanho (P0.3) — vídeo carrega `fileLength` na METADATA do webhook (não dá pra
    // fazer HTTP HEAD: a Evolution só entrega mídia por base64, nunca por URL). Grande demais →
    // recusa SEM baixar/decodificar (evita materializar base64 gigante em memória à toa).
    if (mediaType === "video" && media.fileLength !== undefined && media.fileLength > d.maxWhatsappVideoBytes) {
      await notify(ref, NOTICE.videoTooLarge(Math.round(d.maxWhatsappVideoBytes / (1024 * 1024))), { split: true });
      d.logger.warn({ conversationId, fileLength: media.fileLength }, "intake:video_too_large_metadata");
      return;
    }

    // 3) bytes: imagem pode vir inline (webhook base64:true); vídeo SEMPRE por chave (não
    // trafega no payload). Fallback por `fetchMediaBase64`.
    const inline = media.base64 ?? "";
    const base64 =
      inline.length > 0 ? inline : (await d.ports.messaging.fetchMediaBase64({ instanceId }, media.messageKey)) ?? "";
    if (base64.length === 0) {
      await notify(ref, NOTICE.noBytes, { split: true, quoteLastInbound: true });
      d.logger.warn({ conversationId }, "intake:no_bytes");
      return;
    }
    const bytes = new Uint8Array(Buffer.from(base64, "base64"));

    // vídeo: teto de tamanho PÓS-decode (fallback quando `fileLength` não veio na metadata) —
    // teto de memória do worker. Grande demais → manda pro upload web.
    if (mediaType === "video" && bytes.byteLength > d.maxWhatsappVideoBytes) {
      await notify(ref, NOTICE.videoTooLarge(Math.round(d.maxWhatsappVideoBytes / (1024 * 1024))), { split: true });
      d.logger.warn({ conversationId, bytes: bytes.byteLength }, "intake:video_too_large");
      return;
    }

    try {
      // 3) INGESTÃO compartilhada (mesma fonte do upload web): blob → StoragePort → Meta
      // (image_hash / video_id) → creative_asset dedupado. Conta + token frescos.
      const accessToken = d.ports.vault.decrypt(account.tokenCripto);
      const accountRef: AdAccountRef = { adAccountId: account.metaAdAccountId, accessToken };
      const ext = EXT_BY_TYPE[media.mimetype] ?? (mediaType === "video" ? "mp4" : "jpg");
      const filename = media.caption ? `${media.caption}.${ext}` : `whatsapp-${Date.now()}.${ext}`;
      const ingestInput = { orgId, adAccountId: adAccountUuid, ref: accountRef, bytes, contentType: media.mimetype, filename };

      if (mediaType === "video") {
        const v = await ingestCreativeVideo({ db: d.db, storage: d.ports.storage, ads: d.ports.ads }, ingestInput);
        if (v.status === "pending") {
          // B1: escrita ligada → o poll oferece "usar/criar" ao flipar `ready` (vídeo nasce pending,
          // então a oferta não pode sair agora como na imagem). OFF → sem oferta (só a biblioteca).
          await d.ports.scheduler.enqueue(
            buildCreativeVideoPollJob({
              orgId,
              adAccountId: adAccountUuid,
              assetId: v.assetId,
              metaVideoId: v.metaVideoId,
              attempt: 1,
              ...(d.chatAdsWrites ? { offer: { ref, conversationId } } : {}),
            }),
          );
        }
        await notify(ref, NOTICE.videoSaved(account.name), { split: true, quoteLastInbound: true });
        d.logger.debug({ conversationId, metaVideoId: v.metaVideoId }, "intake:video_saved");
        return;
      }

      const { assetId, metaImageHash } = await ingestCreativeImage(
        { db: d.db, storage: d.ports.storage, ads: d.ports.ads },
        ingestInput,
      );
      // imagem `ready` → analisa a visão 1x (cache) pra biblioteca (mesmo pipeline do web).
      await d.ports.scheduler.enqueue(buildCreativeAnalyzeJob({ orgId, adAccountId: adAccountUuid, assetId }));
      // B3: imagem COM legenda → o turno já respondeu (com a imagem anexada). Salvou em silêncio;
      // não manda cortesia/oferta próprias (o turno é a voz). Analisada + guardada mesmo assim.
      if (payload.suppressNotice) {
        d.logger.debug({ conversationId, metaImageHash }, "intake:saved (suppressed — turno responde)");
        return;
      }
      // v1 (kill-switch): usar o criativo enviado = autoria/edição por chat. OFF → salva na
      // biblioteca e NÃO guarda oferta (o uso num rascunho é na plataforma). ON → fecha o loop
      // (Slice 7): guarda uma OFERTA pro próximo turno resolver no "sim". (Vídeo = fast-follow.)
      if (!d.chatAdsWrites) {
        await notify(ref, NOTICE.savedLibraryOnly(account.name), { split: true, quoteLastInbound: true });
        d.logger.debug({ conversationId, metaImageHash }, "intake:saved (writes off — sem oferta)");
        return;
      }
      const { draftId } = await stageCreativeOffer(
        { db: d.db, redis: d.redis },
        { orgId, adAccountId: adAccountUuid, assetId, conversationId },
      );
      await notify(ref, draftId ? NOTICE.savedOfferUse() : NOTICE.savedOfferCreate(account.name), {
        split: true,
        quoteLastInbound: true,
      });
      d.logger.debug({ conversationId, metaImageHash, offeredDraftId: draftId }, "intake:saved+offer");
    } catch (err) {
      // Falha de IO: RE-LANÇA → BullMQ re-tenta com backoff (upload/storage transitórios). O
      // aviso de cortesia só sai na ÚLTIMA tentativa (`notifyOnFailure`) — senão o usuário
      // receberia "problema pra guardar" a cada retry (até 3×).
      if (notifyOnFailure) await notify(ref, NOTICE.failed, { split: true }).catch(() => undefined);
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
    ports: { ads: ports.ads, messaging: ports.messaging, vault: ports.vault, storage: ports.storage, scheduler: ports.scheduler },
    maxWhatsappVideoBytes: deps.creative.maxWhatsappVideoBytes,
    sendToConversation: createSendToConversation({ messaging: ports.messaging, repo }),
    redis: deps.redis,
    chatAdsWrites: deps.conversation.chatAdsWrites,
    logger,
  });

  return new Worker<WhatsappMediaIntakePayload>(
    WHATSAPP_MEDIA_INTAKE_QUEUE,
    async (job) => {
      // avisa a falha só quando esgotou as tentativas (attemptsMade é 0-based na execução atual).
      const isLastAttempt = job.attemptsMade + 1 >= (job.opts.attempts ?? WHATSAPP_MEDIA_INTAKE_ATTEMPTS);
      await intake(job.data, isLastAttempt);
    },
    { connection },
  );
}
