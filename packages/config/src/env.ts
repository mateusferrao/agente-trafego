import { z } from "zod";

/**
 * Schema de ambiente (§13): validado no boot (fail-fast) via zod.
 * Cobre TODAS as envs do `.env.example`. Secrets obrigatórios devem estar
 * presentes p/ o processo subir; observabilidade (Langfuse) é opcional.
 *
 * Números vêm como string do `process.env` → `z.coerce.number()`.
 */
export const envSchema = z.object({
  // ─── Core ──────────────────────────────────────────────────────────────
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
    .default("info"),

  // ─── HTTP / Auth ───────────────────────────────────────────────────────
  API_PORT: z.coerce.number().int().positive().default(3333),
  WEB_ORIGIN: z.string().url().default("http://localhost:4200"),
  SESSION_SECRET: z
    .string()
    .min(32, "SESSION_SECRET deve ter ao menos 32 bytes"),

  // ─── Postgres (Drizzle) ────────────────────────────────────────────────
  DATABASE_URL: z.string().url(),

  // ─── Redis (BullMQ / governor) ─────────────────────────────────────────
  REDIS_URL: z.string().url(),

  // ─── Credential Vault (AES-256-GCM) ────────────────────────────────────
  // chave mestra base64 de 32 bytes (secret do EasyPanel em produção).
  CREDENTIAL_MASTER_KEY: z
    .string()
    .min(1, "CREDENTIAL_MASTER_KEY é obrigatória"),
  CREDENTIAL_KEY_VERSION: z.coerce.number().int().positive().default(1),

  // ─── LLM (OpenRouter) ──────────────────────────────────────────────────
  OPENROUTER_API_KEY: z.string().min(1, "OPENROUTER_API_KEY é obrigatória"),
  OPENROUTER_MODEL: z.string().min(1).default("google/gemini-2.5-flash"),
  OPENROUTER_VISION_MODEL: z
    .string()
    .min(1)
    .default("google/gemini-2.5-flash"),
  // cap de custo LLM por org por período (USD); 0 = sem cap.
  LLM_COST_CAP_USD_PER_PERIOD: z.coerce.number().min(0).default(0),

  // ─── Meta (Graph API) ──────────────────────────────────────────────────
  META_APP_ID: z.string().min(1, "META_APP_ID é obrigatório"),
  META_APP_SECRET: z.string().min(1, "META_APP_SECRET é obrigatório"),
  META_GRAPH_VERSION: z
    .string()
    .regex(/^v\d+\.\d+$/, "META_GRAPH_VERSION deve ser no formato vXX.Y")
    .default("v26.0"),

  // ─── WhatsApp (Evolution) ──────────────────────────────────────────────
  EVOLUTION_BASE_URL: z.string().url(),
  EVOLUTION_API_KEY: z.string().min(1, "EVOLUTION_API_KEY é obrigatória"),
  // secret validado no webhook inbound.
  EVOLUTION_WEBHOOK_SECRET: z
    .string()
    .min(1, "EVOLUTION_WEBHOOK_SECRET é obrigatório"),

  // ─── Análise / Governor ────────────────────────────────────────────────
  INSIGHTS_RETENTION_DAYS: z.coerce.number().int().positive().default(90),
  ANALYSIS_MAX_CREATIVES_VISION: z.coerce
    .number()
    .int()
    .nonnegative()
    .default(8),

  // ─── Observabilidade (opcional) ────────────────────────────────────────
  LANGFUSE_PUBLIC_KEY: z.string().optional(),
  LANGFUSE_SECRET_KEY: z.string().optional(),
  LANGFUSE_BASE_URL: z.string().url().optional(),
});

/** Tipo validado do ambiente — fonte da verdade p/ o resto do sistema. */
export type Env = z.infer<typeof envSchema>;

/** Erro de validação de ambiente (lançado no boot). */
export class EnvValidationError extends Error {
  constructor(public readonly issues: z.ZodIssue[]) {
    const lines = issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`);
    super(`Variáveis de ambiente inválidas:\n${lines.join("\n")}`);
    this.name = "EnvValidationError";
  }
}

/**
 * Valida `process.env` (ou um source injetado) contra o schema.
 * Deve ser chamada uma vez no boot da api/worker — fail-fast se algo faltar.
 */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    throw new EnvValidationError(result.error.issues);
  }
  return result.data;
}
