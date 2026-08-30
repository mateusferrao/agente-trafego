import type { FastifyPluginAsync } from "fastify";
import type { OrgId } from "@trafego/shared/types";
import { requireAuth } from "../../middleware/auth.js";
import { requireActiveAccess } from "../../middleware/access-gate.js";
import { requireOrgScope, orgIdOf } from "../../middleware/org-scope.js";
import { env } from "../../env.js";
import { geoSearchQuery, interestSearchQuery, scaleWinnerInput, setDraftCreativeInput, setDraftTargetingInput, updateDraftInput } from "./schema.js";
import { isAllowedCreativeType } from "./service.js";

/** Slice de rascunhos de campanha (Fatia 7): listar pendentes + escalar vencedor pelo site. */
export const draftsRoutes: FastifyPluginAsync = async (app) => {
  const service = app.container.services.drafts;
  const guard = { preHandler: [requireAuth, requireOrgScope, requireActiveAccess] };

  app.get("/drafts/pending", guard, async (request) => {
    return service.listPendingDrafts(orgIdOf(request) as OrgId);
  });

  app.post("/accounts/:id/drafts/scale", guard, async (request, reply) => {
    const { id } = request.params as { id: string };
    const input = scaleWinnerInput.parse(request.body);
    const result = await service.scaleWinner(orgIdOf(request) as OrgId, id, input);
    if (!result) return reply.status(404).send({ message: "conta ou agente não encontrado" });
    return result;
  });

  // Edição CONSOLIDADA do rascunho (painel "Editar rascunho"): só os campos alterados. Converge
  // com o chat no núcleo `applyDraftEdit`. Erro tipado do núcleo → 422 com mensagem amigável (§13).
  app.patch("/accounts/:id/drafts/:draftId", guard, async (request, reply) => {
    const { id, draftId } = request.params as { id: string; draftId: string };
    const input = updateDraftInput.parse(request.body);
    const result = await service.updateDraft(orgIdOf(request) as OrgId, id, draftId, input);
    if (!result.ok) return reply.status(422).send({ message: result.message });
    return { ok: true };
  });

  // Troca o criativo de um rascunho from_scratch proposto (picker "trocar criativo"). Body =
  // união { kind:'asset', assetId } (biblioteca) | { kind:'serving', adId } (reuse ao vivo).
  app.post("/accounts/:id/drafts/:draftId/creative", guard, async (request, reply) => {
    const { id, draftId } = request.params as { id: string; draftId: string };
    const input = setDraftCreativeInput.parse(request.body);
    const result = await service.setDraftCreative(orgIdOf(request) as OrgId, id, draftId, input);
    if (!result.ok) return reply.status(422).send({ message: result.message });
    return { ok: true };
  });

  // Alterna o público do rascunho (herda o conjunto que converte × Advantage+ amplo).
  app.post("/accounts/:id/drafts/:draftId/targeting", guard, async (request, reply) => {
    const { id, draftId } = request.params as { id: string; draftId: string };
    const input = setDraftTargetingInput.parse(request.body);
    const result = await service.setDraftTargeting(orgIdOf(request) as OrgId, id, draftId, input.audience);
    if (!result.ok) return reply.status(422).send({ message: result.message });
    return { ok: true, audience: result.audience };
  });

  // Anúncios ao vivo da conta oferecidos como reuse no picker (só vídeo hoje). Lê ad_creatives.
  app.get("/accounts/:id/serving-creatives", guard, async (request) => {
    const { id } = request.params as { id: string };
    return service.listServingCreatives(orgIdOf(request) as OrgId, id);
  });

  // Busca de geo (Fase 1, subfatia 3b) — autocomplete de cidade/região/país no editor de rascunho.
  app.get("/accounts/:id/targeting/geo-search", guard, async (request) => {
    const { id } = request.params as { id: string };
    const { q } = geoSearchQuery.parse(request.query);
    return service.searchGeo(orgIdOf(request) as OrgId, id, q);
  });

  // Busca de interesses (Fase 2, subfatia 4) — autocomplete no editor de rascunho.
  app.get("/accounts/:id/targeting/interest-search", guard, async (request) => {
    const { id } = request.params as { id: string };
    const { q } = interestSearchQuery.parse(request.query);
    return service.searchInterests(orgIdOf(request) as OrgId, id, q);
  });

  // Miniatura do criativo do rascunho (card /approvals). Org-scoped pelo draftId. upload → blob
  // do StoragePort; reuse → busca fresco da Meta e faz stream (fbcdn expira → nunca URL crua).
  // ETag estável pelo id do criativo → browser cacheia + 304 na revalidação (sem tocar na Meta).
  app.get("/accounts/:id/drafts/:draftId/creative/thumb", guard, async (request, reply) => {
    const { id, draftId } = request.params as { id: string; draftId: string };
    const inm = request.headers["if-none-match"];
    const thumb = await service.getDraftCreativeThumb(
      orgIdOf(request) as OrgId,
      id,
      draftId,
      typeof inm === "string" ? inm : undefined,
    );
    if (!thumb) return reply.status(404).send({ message: "miniatura indisponível" });
    const etag = `"${thumb.etag}"`;
    if ("notModified" in thumb) return reply.status(304).header("ETag", etag).send();
    return reply
      .header("Content-Type", thumb.contentType)
      .header("Cache-Control", "private, max-age=86400")
      .header("ETag", etag)
      .header("Content-Disposition", "inline")
      .send(Buffer.from(thumb.bytes));
  });

  app.get("/accounts/:id/creatives", guard, async (request) => {
    const { id } = request.params as { id: string };
    return service.listCreatives(orgIdOf(request) as OrgId, id);
  });

  // Serve o blob original do criativo (preview). Org-scoped pelo lookup do assetId — NUNCA
  // confia num `ref` do cliente. Content-addressed → cache forte + ETag/304. Bucket privado.
  app.get("/accounts/:id/creatives/:assetId/blob", guard, async (request, reply) => {
    const { id, assetId } = request.params as { id: string; assetId: string };
    const blob = await service.getCreativeBlob(orgIdOf(request) as OrgId, id, assetId);
    if (!blob) return reply.status(404).send({ message: "criativo não encontrado" });
    const etag = `"${blob.etag}"`;
    if (request.headers["if-none-match"] === etag) return reply.status(304).send();
    return reply
      .header("Content-Type", blob.contentType)
      .header("Cache-Control", "private, max-age=31536000, immutable")
      .header("ETag", etag)
      .header("Content-Disposition", "inline")
      .send(Buffer.from(blob.bytes));
  });

  // Exclui um criativo da biblioteca — HÍBRIDO (fast-follow #707). Org-scoped pelo lookup do
  // assetId (nunca confia no cliente). Em uso → ARQUIVA (some da biblioteca, mantém ref, não
  // quebra Meta/rascunho); livre → apaga de vez. Ausente → 404. { ok, archived } distingue.
  app.delete("/accounts/:id/creatives/:assetId", guard, async (request, reply) => {
    const { id, assetId } = request.params as { id: string; assetId: string };
    const result = await service.deleteCreative(orgIdOf(request) as OrgId, id, assetId);
    if (!result) return reply.status(404).send({ message: "criativo não encontrado" });
    return { ok: true, archived: result.archived };
  });

  // Upload MULTIPART (imagem OU vídeo). Valida tipo (allowlist) + teto por-tipo → mensagem PT
  // amigável (nunca o erro técnico cru do multipart). `toBuffer` materializa o arquivo em memória
  // (limitado pelo fileSize do multipart) — não é streaming; o ingest precisa dos bytes de qualquer forma.
  app.post("/accounts/:id/creatives/upload", guard, async (request, reply) => {
    const { id } = request.params as { id: string };
    const file = await request.file();
    if (!file) return reply.status(400).send({ message: "Envie um arquivo de imagem ou vídeo." });
    const contentType = file.mimetype;
    if (!isAllowedCreativeType(contentType)) {
      return reply.status(415).send({ message: "Formato não suportado. Envie imagem (JPG/PNG/WebP/GIF) ou vídeo (MP4/MOV)." });
    }
    const isVideo = contentType.startsWith("video/");
    let buf: Buffer;
    try {
      buf = await file.toBuffer(); // respeita o fileSize do multipart (teto de vídeo)
    } catch {
      return reply
        .status(413)
        .send({ message: `Arquivo grande demais. Limite: ${env.CREATIVE_MAX_VIDEO_MB}MB para vídeo.` });
    }
    // teto por-tipo (imagem tem limite menor que o do multipart) → PT amigável.
    const maxMb = isVideo ? env.CREATIVE_MAX_VIDEO_MB : env.CREATIVE_MAX_IMAGE_MB;
    if (buf.byteLength > maxMb * 1024 * 1024) {
      return reply.status(413).send({ message: `Arquivo grande demais. Limite: ${maxMb}MB para ${isVideo ? "vídeo" : "imagem"}.` });
    }
    const result = await service.uploadCreative(orgIdOf(request) as OrgId, id, {
      bytes: new Uint8Array(buf),
      contentType,
      filename: file.filename,
    });
    if (!result) return reply.status(404).send({ message: "conta ou agente não encontrado" });
    return result;
  });
};
