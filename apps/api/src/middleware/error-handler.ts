import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { ZodError } from "zod";

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
export const badRequest = (msg: string, details?: unknown) =>
  new AppError(400, "bad_request", msg, details);

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
    // TODO: mapear erros conhecidos de adapters (ex: Meta code 190) para códigos estáveis.
    request.log.error({ err: error }, "erro não tratado na casca");
    return reply.status(500).send({ code: "internal_error", message: "Erro interno" });
  });
}
