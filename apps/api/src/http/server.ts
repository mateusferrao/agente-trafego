import { pathToFileURL } from "node:url";
import cookie from "@fastify/cookie";
import rateLimit from "@fastify/rate-limit";
import Fastify, { type FastifyInstance } from "fastify";
import { sql } from "drizzle-orm";
import { runMigrations, runBackfillConnections } from "@trafego/db";

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
import { connectionsRoutes } from "../modules/connections/routes.js";
import { channelsRoutes } from "../modules/channels/routes.js";
import { contactsRoutes } from "../modules/contacts/routes.js";
import { agentsRoutes } from "../modules/agents/routes.js";
import { approvalsRoutes } from "../modules/approvals/routes.js";
import { recommendationsRoutes } from "../modules/recommendations/routes.js";
import { runsRoutes } from "../modules/runs/routes.js";
import { dashboardRoutes } from "../modules/dashboard/routes.js";
import { timelineRoutes } from "../modules/timeline/routes.js";
import { billingRoutes } from "../modules/billing/routes.js";
import { webhooksRoutes } from "../modules/webhooks/routes.js";

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
      // Respeita LOG_LEVEL (env, default "info"); dev seta "debug" no .env.
      level: env.LOG_LEVEL,
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
        "req.body.token",
        "req.body.accessToken",
      ],
    },
  });

  // Composition root manual — portas + services montados uma vez.
  app.decorate("container", buildContainer());

  // Sessão (§12): cookie httpOnly com token opaco (casado com `sessions` no DB,
  // revogável). A org ativa mora na sessão no DB, não em cookie. Ver
  // `http/cookies.ts` + slice de auth.
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

  // Liveness (sem prefixo, sem auth): "o processo está de pé". Estático de
  // propósito — é o probe de restart do EasyPanel; NÃO checa deps (senão um
  // Postgres/Redis fora reiniciaria a API em loop, sendo o problema a dependência).
  app.get("/health", async () => ({ status: "ok", ts: new Date().toISOString() }));

  // Readiness: "as dependências respondem" (DB + Redis). Pra monitoramento, não
  // pro probe de restart. 503 quando alguma dep está fora (não derruba o processo).
  app.get("/ready", async (_req, reply) => {
    const checks = { db: false, redis: false };
    try {
      await app.container.adapters.db.execute(sql`select 1`);
      checks.db = true;
    } catch (err) {
      app.log.warn({ err }, "readiness: DB indisponível");
    }
    try {
      checks.redis = (await app.container.redis.ping()) === "PONG";
    } catch (err) {
      app.log.warn({ err }, "readiness: Redis indisponível");
    }
    const ready = checks.db && checks.redis;
    return reply.status(ready ? 200 : 503).send({ status: ready ? "ready" : "not_ready", ...checks });
  });

  // Contrato OpenAPI ao vivo (gerado dos schemas zod) — input do kubb no web.
  app.get("/openapi.json", async () => buildDocument());

  // Webhooks fora do /api (público, valida secret próprio).
  await app.register(webhooksRoutes);

  // Slices de negócio sob /api.
  await app.register(
    async (api) => {
      await api.register(authRoutes);
      await api.register(orgsRoutes);
      await api.register(accountsRoutes);
      await api.register(connectionsRoutes);
      await api.register(channelsRoutes);
      await api.register(contactsRoutes);
      await api.register(agentsRoutes);
      await api.register(approvalsRoutes);
      await api.register(recommendationsRoutes);
      await api.register(runsRoutes);
      await api.register(dashboardRoutes);
      await api.register(timelineRoutes);
      await api.register(billingRoutes);
    },
    { prefix: "/api" },
  );

  // Front Angular (build) + fallback SPA. Registrado por último: os /api,
  // /webhooks, /health, /openapi.json acima têm precedência sobre o fallback.
  await registerStatic(app);

  return app;
}

/**
 * Shutdown gracioso: para de aceitar + drena requests no voo (`app.close()`),
 * depois fecha Redis e o pool do Postgres. Sem isso, todo auto-deploy do
 * EasyPanel (restart) derrubava request no meio. Idempotente (guard `closing`).
 */
let closing = false;
async function shutdown(app: FastifyInstance, signal: string): Promise<void> {
  if (closing) return;
  closing = true;
  app.log.info({ signal }, "encerrando graciosamente");
  try {
    await app.close(); // drena HTTP (para de aceitar, espera in-flight)
    await app.container.redis.quit();
    await app.container.adapters.db.$client.end();
  } catch (err) {
    app.log.error({ err }, "erro no shutdown");
  } finally {
    process.exit(0);
  }
}

/** Entrypoint: sobe o listener na API_PORT. */
async function start(): Promise<void> {
  const app = await buildApp();

  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.once(signal, () => void shutdown(app, signal));
  }

  try {
    // auto-migrate no boot (idempotente) — só a api migra; worker assume o schema.
    if (env.AUTO_MIGRATE) {
      app.log.info("aplicando migrations");
      await runMigrations(env.DATABASE_URL);
      // backfill idempotente: normaliza token de ad_accounts p/ platform_connections.
      const { migrated } = await runBackfillConnections(env.DATABASE_URL);
      app.log.info({ migrated }, "migrations aplicadas");
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
