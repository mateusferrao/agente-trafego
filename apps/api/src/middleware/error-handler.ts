import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { ZodError } from "zod";
import { AdsPlatformError, MessagingChannelError, type AdsPlatformErrorKind } from "@trafego/shared/ports";

/**
 * Mapa erro-de-plataforma → HTTP amigável. A casca NÃO conhece o provider (Meta):
 * o adapter traduz seu erro específico p/ `AdsPlatformError` e aqui vira mensagem.
 */
const ADS_ERROR_HTTP: Record<AdsPlatformErrorKind, { status: number; code: string; message: string }> = {
  invalid_credential: {
    status: 400,
    code: "ads_invalid_credential",
    message: "Não consegui validar esse token. Verifique e cole de novo.",
  },
  not_accessible: {
    status: 400,
    code: "ads_not_accessible",
    message: "Não consegui acessar essa conta com esse token. Verifique e tente de novo.",
  },
  rate_limited: {
    status: 429,
    code: "ads_rate_limited",
    message: "A Meta recebeu chamadas demais agora. Espere alguns minutos e tente de novo.",
  },
  upstream: {
    status: 502,
    code: "ads_unavailable",
    message: "A plataforma de anúncios está indisponível agora. Tente de novo em instantes.",
  },
};

/**
 * Erro de aplicação da casca. O core devolve `Result` tipado; a casca traduz
 * falhas de IO/regra para exceções que este handler mapeia para HTTP.
 */
export class AppError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export const unauthorized = (msg = "Não autenticado") => new AppError(401, "unauthorized", msg);
export const forbidden = (msg = "Sem permissão") => new AppError(403, "forbidden", msg);
export const notFound = (msg = "Não encontrado") => new AppError(404, "not_found", msg);
export const conflict = (msg: string, details?: unknown) =>
  new AppError(409, "conflict", msg, details);
export const badRequest = (msg: string, details?: unknown) =>
  new AppError(400, "bad_request", msg, details);
/** Email ainda não verificado (6b): o front lê o `code` e leva à tela de código. */
export const emailNotVerified = (msg = "Confirme seu email com o código que enviamos.") =>
  new AppError(403, "auth_email_not_verified", msg);
/** Gate de beta (6b): acesso ainda não liberado. O front lê o `code` e mostra o muro. */
export const accessPending = (msg = "Sua conta está em análise. Avisaremos por email quando o acesso for liberado.") =>
  new AppError(403, "access_pending", msg);

/**
 * Registra o error handler global: exceções na casca → resposta padronizada.
 * ZodError (validação de borda) → 400; AppError → seu status; resto → 500.
 */
export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error: FastifyError, request: FastifyRequest, reply: FastifyReply) => {
    if (error instanceof ZodError) {
      return reply
        .status(400)
        .send({ code: "validation_error", message: "Payload inválido", details: error.issues });
    }
    if (error instanceof AppError) {
      return reply
        .status(error.statusCode)
        .send({ code: error.code, message: error.message, details: error.details });
    }
    if (error instanceof AdsPlatformError) {
      const mapped = ADS_ERROR_HTTP[error.kind];
      if (error.kind === "upstream") request.log.error({ err: error }, "plataforma de ads indisponível");
      return reply.status(mapped.status).send({ code: mapped.code, message: mapped.message });
    }
    if (error instanceof MessagingChannelError) {
      // canal (WhatsApp) fora do ar — mensagem amigável, sem vazar o provider.
      request.log.error({ err: error }, "canal de mensageria indisponível");
      return reply.status(503).send({
        code: "channel_unavailable",
        message: "Não consegui falar com o WhatsApp agora. Tente de novo em instantes.",
      });
    }
    // Erros da casca com status próprio de cliente (Fastify: 4xx como 415/405/400)
    // → respeita o status + mensagem, nunca vira 500 genérico.
    const status = (error as { statusCode?: number }).statusCode;
    if (typeof status === "number" && status >= 400 && status < 500) {
      return reply
        .status(status)
        .send({ code: (error as { code?: string }).code ?? "request_error", message: error.message });
    }
    request.log.error({ err: error }, "erro não tratado na casca");
    return reply.status(500).send({ code: "internal_error", message: "Erro interno" });
  });
}
