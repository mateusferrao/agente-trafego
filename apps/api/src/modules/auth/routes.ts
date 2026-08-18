import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { env } from "../../env.js";
import { requireAuth } from "../../middleware/auth.js";
import {
  SESSION_CONTEXT_COOKIE,
  SESSION_TOKEN_COOKIE,
  sealContext,
  sessionCookieOptions,
} from "../../http/cookies.js";
import { loginInput, signupInput } from "./schema.js";
import type { SessionContext, SessionIssued } from "./service.js";

/** Teto de tentativas em endpoints sensíveis (anti brute-force). Aplicado por-rota. */
const AUTH_RATE_LIMIT = { max: 10, timeWindow: "1 minute" };

/** Origem da request p/ trilha da sessão — nunca de input do usuário. */
function contextOf(request: FastifyRequest): SessionContext {
  return { ipAddress: request.ip, userAgent: request.headers["user-agent"] };
}

/** Grava os dois cookies da sessão híbrida: token opaco + contexto selado. */
async function setSessionCookies(reply: FastifyReply, issued: SessionIssued): Promise<void> {
  const opts = sessionCookieOptions(env.NODE_ENV === "production");
  reply.setCookie(SESSION_TOKEN_COOKIE, issued.rawToken, opts);
  const sealed = await sealContext({ activeOrgId: issued.me.orgId }, env.SESSION_SECRET);
  reply.setCookie(SESSION_CONTEXT_COOKIE, sealed, opts);
}

/** Slice de auth: signup/login/logout (públicos) + `me` (protegida). */
export const authRoutes: FastifyPluginAsync = async (app) => {
  const service = app.container.services.auth;

  app.post("/auth/signup", { config: { rateLimit: AUTH_RATE_LIMIT } }, async (request, reply) => {
    const input = signupInput.parse(request.body);
    const issued = await service.signup(input, contextOf(request));
    await setSessionCookies(reply, issued);
    return reply.status(201).send(issued.me);
  });

  app.post("/auth/login", { config: { rateLimit: AUTH_RATE_LIMIT } }, async (request, reply) => {
    const input = loginInput.parse(request.body);
    const issued = await service.login(input, contextOf(request));
    await setSessionCookies(reply, issued);
    return reply.send(issued.me);
  });

  app.post("/auth/logout", async (request, reply) => {
    const token = request.cookies?.[SESSION_TOKEN_COOKIE];
    if (token) await service.logout(token);
    const opts = sessionCookieOptions(env.NODE_ENV === "production");
    reply.clearCookie(SESSION_TOKEN_COOKIE, opts);
    reply.clearCookie(SESSION_CONTEXT_COOKIE, opts);
    return reply.send({ ok: true });
  });

  app.get("/auth/me", { preHandler: [requireAuth] }, async (request) => {
    return service.me(request.userId!);
  });
};
