/**
 * CLI do gate de beta (6b). Substitui o SQL manual por comandos:
 *   pnpm access:grant <email>    → libera (status active) + enfileira email de liberação
 *   pnpm access:revoke <email>   → revoga (status revoked)
 *   pnpm access:list             → lista os grants
 *
 * Uso: `tsx --env-file=.env apps/api/src/scripts/access.ts <cmd> [email]`.
 */
import { eq, sql } from "drizzle-orm";
import { createDb, accessGrants } from "@trafego/db";
import { BullmqScheduler } from "@trafego/scheduler-bullmq";
import { buildMailJob } from "@trafego/shared";
import { loadEnv } from "@trafego/config";
import { Redis } from "ioredis";
import { buildAccessGrantedEmail } from "../modules/auth/auth-email.js";

function normalizeEmail(raw: string | undefined): string {
  const email = (raw ?? "").trim().toLowerCase();
  if (!email) {
    console.error("email obrigatório. Ex: pnpm access:grant fulano@exemplo.com");
    process.exit(1);
  }
  return email;
}

async function main(): Promise<void> {
  const env = loadEnv();
  const db = createDb(env.DATABASE_URL);
  const [cmd, emailArg] = process.argv.slice(2);

  if (cmd === "list") {
    const rows = await db
      .select({ email: accessGrants.email, status: accessGrants.status, activatedAt: accessGrants.activatedAt })
      .from(accessGrants)
      .orderBy(accessGrants.createdAt);
    console.table(rows);
    process.exit(0);
  }

  if (cmd === "grant") {
    const email = normalizeEmail(emailArg);
    // upsert por email (cria se não existir; ativa se já existir).
    await db
      .insert(accessGrants)
      .values({ email, status: "active", activatedAt: new Date() })
      .onConflictDoUpdate({
        target: accessGrants.email,
        set: { status: "active", activatedAt: new Date(), updatedAt: sql`now()` },
      });
    console.log(`✓ acesso liberado: ${email}`);
    // fecha o loop: avisa o usuário por email (best-effort — precisa do worker de mail up).
    const redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
    try {
      const scheduler = new BullmqScheduler(redis);
      await scheduler.enqueue(
        buildMailJob(
          buildAccessGrantedEmail({ to: email, from: env.AUTH_EMAIL_FROM, appUrl: env.FRONTEND_URL }),
        ),
      );
      await scheduler.close();
      console.log("  email de liberação enfileirado (fila core.mail)");
    } finally {
      await redis.quit();
    }
    process.exit(0);
  }

  if (cmd === "revoke") {
    const email = normalizeEmail(emailArg);
    const rows = await db
      .update(accessGrants)
      .set({ status: "revoked", updatedAt: sql`now()` })
      .where(eq(accessGrants.email, email))
      .returning({ email: accessGrants.email });
    console.log(rows.length ? `✓ acesso revogado: ${email}` : `nada a revogar: ${email} não tem grant`);
    process.exit(0);
  }

  console.error("comando inválido. Use: grant <email> | revoke <email> | list");
  process.exit(1);
}

main().catch((err: unknown) => {
  console.error("falha no access CLI:", err);
  process.exit(1);
});
