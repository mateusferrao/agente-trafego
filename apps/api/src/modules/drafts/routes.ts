import type { FastifyPluginAsync } from "fastify";
import type { OrgId } from "@trafego/shared/types";
import { requireAuth } from "../../middleware/auth.js";
import { requireActiveAccess } from "../../middleware/access-gate.js";
import { requireOrgScope, orgIdOf } from "../../middleware/org-scope.js";
import { env } from "../../env.js";
import { scaleWinnerInput, setDraftCreativeInput } from "./schema.js";
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

  // Troca o criativo de um rascunho from_scratch proposto (picker "trocar criativo").
  app.post("/accounts/:id/drafts/:draftId/creative", guard, async (request, reply) => {
    const { id, draftId } = request.params as { id: string; draftId: string };
    const input = setDraftCreativeInput.parse(request.body);
    const result = await service.setDraftCreative(orgIdOf(request) as OrgId, id, draftId, input.assetId);
    if (!result) return reply.status(404).send({ message: "não consegui trocar o criativo desse rascunho" });
    return result;
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

  // Upload MULTIPART (imagem OU vídeo). Valida tipo (allowlist) + teto por-tipo → mensagem PT
  // amigável (nunca o erro técnico cru do multipart). Vídeo grande faz streaming (não base64).
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
