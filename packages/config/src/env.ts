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
  // Sessão = token opaco no cookie + hash no Postgres (nenhum segredo de app
  // p/ assinar/selar cookie). Se um dia entrar cookie assinado/CSRF token,
  // reintroduzir um SESSION_SECRET aqui.
  API_PORT: z.coerce.number().int().positive().default(3333),
  WEB_ORIGIN: z.string().url().default("http://localhost:4200"),

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
  // Default = modelo FORTE p/ validar o teto de qualidade da análise (3a). Trocável
  // em 1 linha por env; a otimização de custo/modelo (e config por-agente) vem depois.
  OPENROUTER_MODEL: z.string().min(1).default("google/gemini-2.5-pro"),
  OPENROUTER_VISION_MODEL: z
    .string()
    .min(1)
    .default("google/gemini-2.5-flash"),
  // Map-reduce (3b-2): modelo barato por-anúncio (mapa) + modelo barato do redator do
  // WhatsApp. Síntese/reviewer usam OPENROUTER_MODEL (forte). Override por-agente (Fatia 4).
  OPENROUTER_UNIT_MODEL: z.string().min(1).default("google/gemini-2.5-flash"),
  OPENROUTER_MESSAGE_MODEL: z.string().min(1).default("google/gemini-2.5-flash"),
  // Versão do analisador de visão — bumpar invalida o cache de análises de criativo.
  CREATIVE_VISION_ANALYZER_VERSION: z.coerce.number().int().positive().default(1),
  LLM_COST_CAP_USD_PER_PERIOD: z.coerce.number().min(0).default(0),
  // Retentativas in-process por chamada de LLM (429/5xx/rede/passthrough do provider).
  LLM_MAX_RETRIES: z.coerce.number().int().nonnegative().default(3),
  // Revisor (Analista→Revisor) ligado por padrão; default global — override por-agente
  // em `agents.model_config.reviewEnabled` (Fatia 4 edita).
  ANALYSIS_REVIEW_ENABLED: z.enum(["true", "false"]).default("true").transform((v) => v === "true"),
  // Teto de tokens de SAÍDA por chamada de LLM (controla custo/trunca). Override por-agente.
  // Folga p/ reasoning + JSON caberem juntos (modelos que "pensam" gastam saída antes da resposta).
  ANALYSIS_MAX_OUTPUT_TOKENS: z.coerce.number().int().positive().default(8000),
  // Esforço de reasoning nos passos de LLM (unit/síntese/revisão). `off` desliga.
  // Override por-agente em `agents.model_config.reasoningEffort` (Fatia 4).
  ANALYSIS_REASONING_EFFORT: z.enum(["off", "low", "medium", "high"]).default("medium"),
  // URL base do OpenRouter (default oficial; trocável p/ gateway/proxy).
  OPENROUTER_BASE_URL: z.string().url().default("https://openrouter.ai/api/v1"),

  // ─── Meta (Graph API) ──────────────────────────────────────────────────
  // A versão do Graph NÃO é env (é const acoplada ao adapter: `META_GRAPH_VERSION`
  // em @trafego/ads-meta). App ID + secret são **opcionais por enquanto**: o
  // onboarding (1b) chama a Graph token-only (cola token → GET /me/adaccounts).
  // Voltam a ser necessários no fast-follow de checagem de escopos (/debug_token)
  // + appsecret_proof.
  META_APP_ID: z.string().optional(),
  META_APP_SECRET: z.string().optional(),

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
  // Single-tenant da Fatia 0 — aposentado na 3b (instância = 1 por org em
  // `channel_instances`, criada no onboarding por QR). Mantido opcional p/ não
  // quebrar .env existentes; não é mais lido pelo código.
  EVOLUTION_INSTANCE: z.string().optional(),

  // ─── Análise / Governor ────────────────────────────────────────────────
  // INSIGHTS_RETENTION_DAYS = knob de ops (janela de retenção), env ok.
  INSIGHTS_RETENTION_DAYS: z.coerce.number().int().positive().default(90),
  // Quantos dias RECENTES o sync re-baixa a cada run p/ pegar conversões que a
  // Meta atribui a dias passados com atraso (frescura do snapshot). ≠ janela de
  // atribuição da Meta (essa é por-adset, no adapter). ~ maior janela de atribuição.
  INSIGHTS_REFETCH_WINDOW_DAYS: z.coerce.number().int().positive().default(7),
  // TTL do cache (Redis) da lista de conversões personalizadas por conta. Um id
  // fora do cache dispara refresh (self-healing), então o TTL pode ser folgado.
  CUSTOM_CONVERSIONS_CACHE_TTL_SEC: z.coerce.number().int().positive().default(21600),
  // ANALYSIS_MAX_CREATIVES_VISION = default global; alvo = config por agente (DB).
  // Fallback até 4 ligar a config por-agente. Não-usado na Fatia 0.
  ANALYSIS_MAX_CREATIVES_VISION: z.coerce
    .number()
    .int()
    .nonnegative()
    .default(8),
  // Janela da análise on-demand (3a): últimos N dias vs os N anteriores (baseline).
  // Default global; alvo = config por-agente (Fatia 4). ICP faz lançamentos → 7d.
  ANALYSIS_WINDOW_DAYS: z.coerce.number().int().positive().default(7),
  ANALYSIS_BASELINE_DAYS: z.coerce.number().int().positive().default(7),
  // Quantas entidades por nível o brief seleciona (top-N por spend + flagadas).
  ANALYSIS_TOP_N: z.coerce.number().int().positive().default(5),

  // ─── Cadência (cron por conta — 3b) ────────────────────────────────────
  // Default global da cadência (a UI de edição por-conta = Fatia 4). Cron 5-campos.
  ANALYSIS_CRON_DEFAULT: z.string().min(1).default("0 8 * * *"), // 08:00 diário
  // Timezone p/ avaliar o cron (ICP BR). Config por-conta = fast-follow.
  ANALYSIS_TZ: z.string().min(1).default("America/Sao_Paulo"),
  // Stagger máx. (ms) entre contas p/ não bater o rate-limit da Meta ao mesmo tempo.
  ANALYSIS_CRON_JITTER_MS: z.coerce.number().int().nonnegative().default(300000), // 5 min
  // Política de execução default (3b-2): deep completo + incremental nos demais dias.
  // Override por-agente em `agents.model_config.executionPolicy` (Fatia 4 edita).
  ANALYSIS_EXECUTION_POLICY: z
    .enum(["deep_periodic_incremental", "full_every_run", "budget_scaled"])
    .default("deep_periodic_incremental"),
  // Intervalo (dias) entre análises DEEP completas na política incremental.
  ANALYSIS_DEEP_INTERVAL_DAYS: z.coerce.number().int().positive().default(7),
  // Limiar de "mudança material" (variação relativa de métrica) p/ reanalisar a unidade.
  ANALYSIS_MATERIAL_CHANGE_PCT: z.coerce.number().min(0).default(15),
  // Reaper (3b): idade (min) além da qual um run pending/running é dado como preso
  // (crash duro) e marcado failed — libera o índice in-flight p/ o agente voltar.
  ANALYSIS_RUN_STALE_MINUTES: z.coerce.number().int().positive().default(30),
  // Cadência do reaper (cron 5-campos) — varre runs presos periodicamente.
  ANALYSIS_REAPER_CRON: z.string().min(1).default("*/15 * * * *"), // a cada 15 min

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
