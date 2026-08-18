import { z } from "zod";

/**
 * Env mínima da casca HTTP. A validação canônica de env vive em
 * `packages/config` (schema zod validado no boot) — aqui só lemos o que a
 * API precisa para subir. TODO: substituir por `@trafego/config` quando existir.
 */
const envSchema = z.object({
  API_PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().default("postgres://postgres:postgres@localhost:5432/trafego"),
  SESSION_SECRET: z.string().min(32).default("dev-session-secret-change-me-please-32b"),
  EVOLUTION_WEBHOOK_SECRET: z.string().default("dev-evolution-webhook-secret"),
  CREDENTIAL_MASTER_KEY: z.string().default("dev-credential-master-key"),
  OPENROUTER_API_KEY: z.string().default(""),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
});

export type Env = z.infer<typeof envSchema>;

export const env: Env = envSchema.parse(process.env);
