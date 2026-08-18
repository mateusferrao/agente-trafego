import { pathToFileURL } from "node:url";
import cookie from "@fastify/cookie";
import rateLimit from "@fastify/rate-limit";
import Fastify, { type FastifyInstance } from "fastify";
import { runMigrations } from "@trafego/db";

import { env } from "../env.js";
import { buildDocument } from "../openapi/generate.js";
import { buildContainer } from "../composition.js";
import { registerAudit } from "../middleware/audit.js";
import { registerErrorHandler } from "../middleware/error-handler.js";
import { registerStatic } from "./static.js";

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
    // Atrás do proxy do EasyPanel/nginx (§14): confia no X-Forwarded-For para
    // `request.ip` refletir o cliente real — senão o rate-limit de login vira um
    // bucket global (lockout de todos) e o IP em sessão/audit fica o do proxy.
    trustProxy: true,
    logger: {
      level: env.NODE_ENV === "production" ? "info" : "debug",
      // rede de segurança: nunca vazar segredo em log (§12). Token = joia da coroa;
      // senha nunca deve aparecer (defense-in-depth caso alguém logue o body).
      redact: [
        "token",
        "accessToken",
        "password",
        "*.token",
        "*.accessToken",
        "*.tokenCripto",
        "*.password",
        "req.body.password",
      ],
    },
  });

  // Composition root manual — portas + services montados uma vez.
  app.decorate("container", buildContainer());

  // Sessão híbrida (§12): cookies via @fastify/cookie. O token opaco vai num
  // cookie httpOnly (casado com `sessions` no DB); o contexto (org ativa) vai
  // num cookie selado por iron-session. Ver `http/cookies.ts` + slice de auth.
  await app.register(cookie);

  // Rate-limit (Redis compartilhado) — opt-in por rota (`global: false`),
  // aplicado em endpoints sensíveis (login/signup) contra brute-force.
  await app.register(rateLimit, {
    global: false,
    redis: app.container.redis,
    nameSpace: "trafego-rl:",
  });

  // Cross-cutting: erros na casca → resposta; audit+metering em writes.
  registerErrorHandler(app);
  registerAudit(app);

  // Health check (sem prefixo, sem auth).
  app.get("/health", async () => ({ status: "ok", ts: new Date().toISOString() }));

  // Contrato OpenAPI ao vivo (gerado dos schemas zod) — input do kubb no web.
  app.get("/openapi.json", async () => buildDocument());

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

  // Front Angular (build) + fallback SPA. Registrado por último: os /api, /admin,
  // /webhooks, /health, /openapi.json acima têm precedência sobre o fallback.
  await registerStatic(app);

  return app;
}

/** Entrypoint: sobe o listener na API_PORT. */
async function start(): Promise<void> {
  const app = await buildApp();
  try {
    // auto-migrate no boot (idempotente) — só a api migra; worker assume o schema.
    if (env.AUTO_MIGRATE) {
      app.log.info("aplicando migrations");
      await runMigrations(env.DATABASE_URL);
      app.log.info("migrations aplicadas");
    }
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
