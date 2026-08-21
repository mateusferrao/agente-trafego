import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import fastifyStatic from "@fastify/static";
import type { FastifyInstance } from "fastify";

/**
 * Diretório do build Angular servido pela api (mesma origem que o /api → cookie
 * de sessão same-origin, sem CORS). Default do application-builder (projeto
 * `web`): `apps/web/dist/web/browser`. Override por env em cenários de container.
 */
const DEFAULT_WEB_DIST = fileURLToPath(new URL("../../../web/dist/web/browser", import.meta.url));

/** Prefixos servidos pela api (não caem no fallback SPA). */
const API_PREFIXES = ["/api", "/webhooks", "/health", "/ready", "/openapi.json"] as const;

export function isApiPath(url: string): boolean {
  return API_PREFIXES.some((p) => url === p || url.startsWith(`${p}/`) || url.startsWith(`${p}?`));
}

/**
 * Serve o SPA Angular + assets estáticos, com **fallback SPA**: qualquer GET que
 * não bata num arquivo nem num prefixo de api devolve `index.html` (deep-links do
 * router funcionam no reload). Se o build ainda não existe (dev sem `ng build`),
 * não registra nada — a api roda em modo só-API e o front vem do `ng serve`.
 */
export async function registerStatic(app: FastifyInstance, webDist = DEFAULT_WEB_DIST): Promise<void> {
  if (!existsSync(webDist)) {
    app.log.warn({ webDist }, "build do web ausente — servindo só a API (dev usa ng serve)");
    return;
  }

  // wildcard:true resolve o arquivo do disco POR REQUEST (robusto a rebuild/
  // redeploy — não faz glob no boot). Arquivo inexistente → callNotFound → o
  // notFoundHandler abaixo devolve o index.html (fallback SPA) ou 404 de api.
  await app.register(fastifyStatic, { root: webDist, wildcard: true });

  // Fallback SPA: rota não encontrada + GET + fora dos prefixos de api → index.html.
  app.setNotFoundHandler((request, reply) => {
    if (request.method !== "GET" || isApiPath(request.url)) {
      return reply.status(404).send({ code: "not_found", message: "Recurso não encontrado" });
    }
    return reply.sendFile("index.html");
  });
}
