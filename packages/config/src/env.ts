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

  // aplica migrations no boot da api (idempotente). false = migrar fora (CI/release).
  AUTO_MIGRATE: z.enum(["true", "false"]).default("true").transform((v) => v === "true"),

  // ─── Credential Vault (AES-256-GCM) ────────────────────────────────────
  // chave mestra base64 de 32 bytes (secret do EasyPanel em produção).
  CREDENTIAL_MASTER_KEY: z
    .string()
    .refine((v) => {
      try {
        return Buffer.from(v, "base64").length === 32;
      } catch {
        return false;
      }
    }, "CREDENTIAL_MASTER_KEY deve ter 32 bytes em base64"),
  CREDENTIAL_KEY_VERSION: z.coerce.number().int().positive().default(1),

  // ─── LLM (OpenRouter) ──────────────────────────────────────────────────
  // Secret = env. OPENROUTER_MODEL/VISION_MODEL e LLM_COST_CAP são **defaults
  // globais** de produto — o alvo é config na DB (modelo por agente em
  // `agents.model_config`; cap por org em `guardrail_configs.llm_cost_cap`).
  // Ficam aqui como fallback até 3a/4 ligarem a config por-agente/org. Não-usados na Fatia 0.
  OPENROUTER_API_KEY: z.string().min(1, "OPENROUTER_API_KEY é obrigatória"),
  OPENROUTER_MODEL: z.string().min(1).default("google/gemini-2.5-flash"),
  OPENROUTER_VISION_MODEL: z
    .string()
    .min(1)
    .default("google/gemini-2.5-flash"),
  LLM_COST_CAP_USD_PER_PERIOD: z.coerce.number().min(0).default(0),

  // ─── Meta (Graph API) ──────────────────────────────────────────────────
  // A versão do Graph NÃO é env (é const acoplada ao adapter: `META_GRAPH_VERSION`
  // em @trafego/ads-meta). Aqui só App ID + secret.
  META_APP_ID: z.string().min(1, "META_APP_ID é obrigatório"),
  META_APP_SECRET: z.string().min(1, "META_APP_SECRET é obrigatório"),

  // ─── WhatsApp (Evolution) ──────────────────────────────────────────────
  // Nível OPERADOR (compartilhado): 1 servidor Evolution hospeda as instâncias
  // de todos os clientes. Base URL + API key global (admin) = env.
  EVOLUTION_BASE_URL: z.string().url(),
  EVOLUTION_API_KEY: z.string().min(1, "EVOLUTION_API_KEY é obrigatória"),
  // ⚠️ POR-ORG (scaffolding Fatia 0): instância + webhook secret são de tenant —
  // o alvo é `channel_instances(evolution_instance, webhook_secret)` no DB (1 por
  // org). Webhook secret PRECISA ser por-instância (identifica o org pelo nome da
  // instância no payload inbound + rotação independente). Migram na fatia de
  // onboarding WhatsApp (Integrações/QR — 5b). Aqui só até lá.
  EVOLUTION_WEBHOOK_SECRET: z
    .string()
    .min(1, "EVOLUTION_WEBHOOK_SECRET é obrigatório"),
  EVOLUTION_INSTANCE: z.string().min(1, "EVOLUTION_INSTANCE é obrigatória"),

  // ─── Fatia 0 (scaffolding — removido quando houver UI/auth/contatos) ────
  // guard dos endpoints admin até a auth real (Fatia 1a). Segredo forte (32+).
  BETA_ADMIN_SECRET: z.string().min(32, "BETA_ADMIN_SECRET deve ter ao menos 32 chars"),
  // destinatário fixo do WhatsApp na espinha: só dígitos com DDI (ex: 5511999999999).
  FATIA0_RECIPIENT_PHONE: z
    .string()
    .regex(/^\d{8,15}$/, "FATIA0_RECIPIENT_PHONE deve ser só dígitos com DDI (ex: 5511999999999)"),

  // ─── Análise / Governor ────────────────────────────────────────────────
  // INSIGHTS_RETENTION_DAYS = knob de ops (janela de retenção), env ok.
  INSIGHTS_RETENTION_DAYS: z.coerce.number().int().positive().default(90),
  // ANALYSIS_MAX_CREATIVES_VISION = default global; alvo = config por agente (DB).
  // Fallback até 4 ligar a config por-agente. Não-usado na Fatia 0.
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
