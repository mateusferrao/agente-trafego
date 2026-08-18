import { pathToFileURL } from "node:url";
import cookie from "@fastify/cookie";
import session from "@fastify/session";
import Fastify, { type FastifyInstance } from "fastify";

import { env } from "../env.js";
import { buildContainer } from "../composition.js";
import { registerAudit } from "../middleware/audit.js";
import { registerErrorHandler } from "../middleware/error-handler.js";

// Slices (VSA): cada módulo é um plugin Fastify montado pela composição.
import { authRoutes } from "../modules/auth/routes.js";
import { orgsRoutes } from "../modules/orgs/routes.js";
import { accountsRoutes } from "../modules/accounts/routes.js";
import { channelsRoutes } from "../modules/channels/routes.js";
import { agentsRoutes } from "../modules/agents/routes.js";
import { approvalsRoutes } from "../modules/approvals/routes.js";
import { runsRoutes } from "../modules/runs/routes.js";
import { billingRoutes } from "../modules/billing/routes.js";
import { webhooksRoutes } from "../modules/webhooks/routes.js";
import { adminRoutes } from "../modules/admin/routes.js";

// Efeito colateral: augmentações de tipo (session, request.orgId, container).
import "./types.js";

/**
 * Monta a app Fastify: composition root → session → cross-cutting → slices.
 * Exportado p/ testes (inject) sem subir o listener.
 */
export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: env.NODE_ENV === "production" ? "info" : "debug",
      // rede de segurança: nunca vazar o token em log (joia da coroa — §12).
      redact: ["token", "accessToken", "*.token", "*.accessToken", "*.tokenCripto"],
    },
  });

  // Composition root manual — portas + services montados uma vez.
  app.decorate("container", buildContainer());

  // Sessão custom (§4/§12): cookie SameSite + store de sessão.
  // TODO: CLAUDE.md decide iron-session + argon2; @fastify/session é o placeholder.
  await app.register(cookie);
  await app.register(session, {
    secret: env.SESSION_SECRET,
    cookieName: "trafego_sid",
    cookie: {
      httpOnly: true,
      sameSite: "lax",
      secure: env.NODE_ENV === "production",
      maxAge: 1000 * 60 * 60 * 24 * 7,
    },
  });

  // Cross-cutting: erros na casca → resposta; audit+metering em writes.
  registerErrorHandler(app);
  registerAudit(app);

  // Health check (sem prefixo, sem auth).
  app.get("/health", async () => ({ status: "ok", ts: new Date().toISOString() }));

  // Webhooks fora do /api (público, valida secret próprio).
  await app.register(webhooksRoutes);

  // Admin (Fatia 0): fora do /api, guardado por header x-admin-secret.
  await app.register(adminRoutes);

  // Slices de negócio sob /api.
  await app.register(
    async (api) => {
      await api.register(authRoutes);
      await api.register(orgsRoutes);
      await api.register(accountsRoutes);
      await api.register(channelsRoutes);
      await api.register(agentsRoutes);
      await api.register(approvalsRoutes);
      await api.register(runsRoutes);
      await api.register(billingRoutes);
    },
    { prefix: "/api" },
  );

  return app;
}

/** Entrypoint: sobe o listener na API_PORT. */
async function start(): Promise<void> {
  const app = await buildApp();
  try {
    await app.listen({ port: env.API_PORT, host: "0.0.0.0" });
  } catch (err) {
    app.log.error({ err }, "falha ao subir a API");
    process.exit(1);
  }
}

// Só inicia quando executado direto (não em import de teste). pathToFileURL
// normaliza o path (Windows/POSIX) para bater com import.meta.url.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void start();
}
