import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { env } from "../../env.js";
import { requireAuth } from "../../middleware/auth.js";
import { SESSION_TOKEN_COOKIE, sessionCookieOptions } from "../../http/cookies.js";
import {
  emailCodeRequestInput,
  emailCodeVerifyInput,
  forgotPasswordInput,
  loginInput,
  resetPasswordInput,
  signupInput,
} from "./schema.js";
import type { SessionContext, SessionIssued } from "./service.js";

/** Teto de tentativas em endpoints sensíveis (anti brute-force). Aplicado por-rota. */
const AUTH_RATE_LIMIT = { max: 10, timeWindow: "1 minute" };

/** Origem da request p/ trilha da sessão — nunca de input do usuário. */
function contextOf(request: FastifyRequest): SessionContext {
  return { ipAddress: request.ip, userAgent: request.headers["user-agent"] };
}

/** Grava o cookie de sessão (token opaco; a org ativa mora na sessão no DB). */
function setSessionCookie(reply: FastifyReply, issued: SessionIssued): void {
  reply.setCookie(
    SESSION_TOKEN_COOKIE,
    issued.rawToken,
    sessionCookieOptions(env.NODE_ENV === "production"),
  );
}

/** Slice de auth: signup/login/logout (públicos) + `me` (protegida). */
export const authRoutes: FastifyPluginAsync = async (app) => {
  const service = app.container.services.auth;

  // Signup (6b) NÃO autentica: cria a conta não-verificada + manda o código.
  // Sem cookie — a sessão nasce em /auth/email-code/verify.
  app.post("/auth/signup", { config: { rateLimit: AUTH_RATE_LIMIT } }, async (request, reply) => {
    const input = signupInput.parse(request.body);
    const out = await service.signup(input);
    return reply.status(201).send(out);
  });

  // Reenvia/pede código de verificação. Sempre 204 (anti-enumeração).
  app.post(
    "/auth/email-code/request",
    { config: { rateLimit: AUTH_RATE_LIMIT } },
    async (request, reply) => {
      const input = emailCodeRequestInput.parse(request.body);
      await service.requestEmailCode(input);
      return reply.status(204).send();
    },
  );

  // Verifica o código → confirma o email + cria a sessão (seta o cookie).
  app.post(
    "/auth/email-code/verify",
    { config: { rateLimit: AUTH_RATE_LIMIT } },
    async (request, reply) => {
      const input = emailCodeVerifyInput.parse(request.body);
      const issued = await service.verifyEmailCode(input, contextOf(request));
      setSessionCookie(reply, issued);
      return reply.send(issued.me);
    },
  );

  app.post("/auth/login", { config: { rateLimit: AUTH_RATE_LIMIT } }, async (request, reply) => {
    const input = loginInput.parse(request.body);
    const issued = await service.login(input, contextOf(request));
    setSessionCookie(reply, issued);
    return reply.send(issued.me);
  });

  // Pede o link de reset. Sempre 204 (anti-enumeração).
  app.post(
    "/auth/forgot-password",
    { config: { rateLimit: AUTH_RATE_LIMIT } },
    async (request, reply) => {
      const input = forgotPasswordInput.parse(request.body);
      await service.forgotPassword(input);
      return reply.status(204).send();
    },
  );

  // Aplica a nova senha via token do link (revoga as outras sessões).
  app.post(
    "/auth/reset-password",
    { config: { rateLimit: AUTH_RATE_LIMIT } },
    async (request, reply) => {
      const input = resetPasswordInput.parse(request.body);
      await service.resetPassword(input);
      return reply.status(204).send();
    },
  );

  app.post("/auth/logout", async (request, reply) => {
    const token = request.cookies?.[SESSION_TOKEN_COOKIE];
    if (token) await service.logout(token);
    reply.clearCookie(SESSION_TOKEN_COOKIE, sessionCookieOptions(env.NODE_ENV === "production"));
    return reply.send({ ok: true });
  });

  app.get("/auth/me", { preHandler: [requireAuth] }, async (request) => {
    return service.me(request.userId!);
  });
};
