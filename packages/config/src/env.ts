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
  // Origin PÚBLICO da API — p/ montar a URL do webhook Evolution no `connect`
  // (`${API_ORIGIN}/webhooks/evolution/{instance}`). Em prod = domínio público
  // (a Evolution hospedada precisa alcançar a API). Local = tunnel/localhost.
  API_ORIGIN: z.string().url().default("http://localhost:3333"),

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
  OPENROUTER_MODEL: z.string().min(1).default("x-ai/grok-4.5"),
  OPENROUTER_VISION_MODEL: z
    .string()
    .min(1)
    .default("google/gemini-3.1-flash-lite"),
  // Map-reduce (3b-2): modelo barato por-campanha (mapa) + modelo barato do redator do
  // WhatsApp. Síntese/reviewer usam OPENROUTER_MODEL (forte). Override por-agente (Fatia 4).
  OPENROUTER_UNIT_MODEL: z.string().min(1).default("deepseek/deepseek-v4-flash-0731"),
  OPENROUTER_MESSAGE_MODEL: z.string().min(1).default("google/gemini-3.1-flash-lite"),
  // Versão do analisador de visão — bumpar invalida o cache de análises de criativo.
  // 2 (Fatia 6c): multi-frame HD + decomposição hook/angle/format/cta.
  // 3 (Bloco 2): decomposição ganha body + proofStrength → invalida o cache antigo uma vez.
  CREATIVE_VISION_ANALYZER_VERSION: z.coerce.number().int().positive().default(3),
  // Frames HD por criativo de vídeo enviados à visão (espaçados; imagem = 1). Fatia 6c.
  ANALYSIS_VISION_FRAMES: z.coerce.number().int().positive().default(4),
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
  // TTL do cache (Redis) do CATÁLOGO de entidades por conta (§7 — corta o listEntities
  // full a cada run, maior fonte de rate-limit). Invalidado na escrita real. `0` desliga.
  META_ENTITY_CACHE_TTL_SEC: z.coerce.number().int().min(0).default(1800),
  // Frescura (6a): idade máx. (min) do snapshot mais novo antes de disparar sync-only
  // (porta `shouldSync`, compartilhada por sweep/lazy/análise/botão). Também = intervalo
  // do sweep periódico. ~2-3h de default (equilíbrio frescura × chamadas Meta).
  INSIGHTS_FRESH_THRESHOLD_MIN: z.coerce.number().int().positive().default(120),
  // ANALYSIS_MAX_CREATIVES_VISION = default global; alvo = config por agente (DB).
  // Fallback até 4 ligar a config por-agente. Não-usado na Fatia 0.
  ANALYSIS_MAX_CREATIVES_VISION: z.coerce
    .number()
    .int()
    .nonnegative()
    .default(8),
  // Anúncios detalhados por campanha na árvore curada (mapa por-campanha). Resto vira
  // cauda agregada. Default global; override por-agente em `agents.model_config`.
  ANALYSIS_NOTABLE_ADS_PER_CAMPAIGN: z.coerce.number().int().positive().default(5),
  // Teto de criativos com visão POR campanha (prioriza maior gasto/flag). Distinto do
  // teto global ANALYSIS_MAX_CREATIVES_VISION — aqui o custo de visão escala por campanha.
  ANALYSIS_MAX_CREATIVES_VISION_PER_CAMPAIGN: z.coerce.number().int().nonnegative().default(3),
  // Concorrência do mapa por-campanha (quantas campanhas analisadas em paralelo). O
  // map-reduce é o gargalo do run (1+ calls de LLM por campanha, sequenciais hoje).
  // Modesto p/ não bater o rate-limit do OpenRouter (o adapter já tem retry/backoff).
  ANALYSIS_MAP_CONCURRENCY: z.coerce.number().int().positive().default(4),
  // Janela da análise on-demand (3a): últimos N dias vs os N anteriores (baseline).
  // Default global; alvo = config por-agente (Fatia 4). ICP faz lançamentos → 7d.
  ANALYSIS_WINDOW_DAYS: z.coerce.number().int().positive().default(7),
  ANALYSIS_BASELINE_DAYS: z.coerce.number().int().positive().default(7),
  // Quantas entidades por nível o brief seleciona (top-N por spend + flagadas).
  ANALYSIS_TOP_N: z.coerce.number().int().positive().default(5),

  // ─── Qualidade (Fatia 6c) — limiares determinísticos, overridáveis por-agente ─
  // Significância: mín. conversões de negócio OU cliques na janela p/ concluir/agir.
  ANALYSIS_QUALITY_MIN_CONVERSIONS: z.coerce.number().int().positive().default(20),
  ANALYSIS_QUALITY_MIN_CLICKS: z.coerce.number().int().positive().default(100),
  // Fadiga (2+ sinais): queda relativa de CTR (%), frequência de alerta, alta de custo (%).
  ANALYSIS_QUALITY_FATIGUE_CTR_DROP_PCT: z.coerce.number().nonnegative().default(20),
  ANALYSIS_QUALITY_FATIGUE_FREQUENCY: z.coerce.number().positive().default(3),
  // Teto de frequência por estágio (§Bloco 2): prospecção satura cedo, remarketing tolera alto.
  ANALYSIS_QUALITY_FREQUENCY_CAP_PROSPECTING: z.coerce.number().positive().default(2.5),
  ANALYSIS_QUALITY_FREQUENCY_CAP_REMARKETING: z.coerce.number().positive().default(8),
  ANALYSIS_QUALITY_FATIGUE_COST_RISE_PCT: z.coerce.number().nonnegative().default(30),
  // Zombie: gasto mínimo na janela (moeda da conta) p/ chamar de desperdício com 0 conversão.
  ANALYSIS_QUALITY_ZOMBIE_MIN_SPEND: z.coerce.number().nonnegative().default(50),
  // Mostrar a referência de plataforma no cold-start (sem meta E sem histórico).
  ANALYSIS_QUALITY_COLD_START_REFERENCE: z.enum(["true", "false"]).default("true").transform((v) => v === "true"),
  // Tracking furado (§Bloco 2): conversas/max(conversões,1) acima da razão + piso de conversas.
  ANALYSIS_QUALITY_TRACKING_BROKEN_RATIO: z.coerce.number().positive().default(50),
  ANALYSIS_QUALITY_TRACKING_BROKEN_MIN_FUNNEL: z.coerce.number().nonnegative().default(50),

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
  // Cadência da expiração de aprovações (5b) — varre pendentes vencidas (24h).
  APPROVAL_EXPIRY_CRON: z.string().min(1).default("*/15 * * * *"), // a cada 15 min
  // Janela (dias) em que "reverter" uma ação segue disponível — depois some/API recusa.
  REVERT_TTL_DAYS: z.coerce.number().int().positive().default(7),

  // ─── Conversa (WhatsApp — Grafo B ReAct, 5b-2) ─────────────────────────
  // Modelo do chat: fallback quando o agente não tem `model_config.messageModel`.
  // Chat = alto volume + tarefa simples → default barato com bom tool-calling.
  CONVERSATION_MODEL: z.string().min(1).default("google/gemini-3.7-flash"),
  // Janela de contexto por TURNO enviada ao LLM (turno = fala do usuário + resposta
  // completa até a próxima fala; nunca quebra par tool_call/tool_result).
  CONVERSATION_HISTORY_TURNS: z.coerce.number().int().positive().default(8),
  // Teto de tokens (aprox., por chars) da janela — 2ª rede sobre turnos "gordos".
  CONVERSATION_MAX_TOKENS: z.coerce.number().int().positive().default(6000),
  // Debounce do inbound: coalesce mensagens picadas do mesmo contato num turno só.
  CONVERSATION_DEBOUNCE_SECONDS: z.coerce.number().int().nonnegative().default(5),

  // ─── Transcrição de áudio inbound (STT via OpenRouter) ─────────────────
  // Nota de voz do WhatsApp → texto na borda. Reusa OPENROUTER_API_KEY/BASE_URL.
  // Modelo trocável a qualquer momento (ex: openai/gpt-4o-transcribe).
  TRANSCRIPTION_MODEL: z.string().min(1).default("openai/whisper-large-v3-turbo"),
  // Dica ISO-639-1 (melhora PT-BR); vazio = auto-detect do provider.
  TRANSCRIPTION_LANGUAGE: z.string().default("pt"),
  // Teto de tamanho do áudio (MB) — acima disso não transcreve (aviso amigável).
  TRANSCRIPTION_MAX_AUDIO_MB: z.coerce.number().int().positive().default(16),
  // Timeout (ms) da chamada de transcrição.
  TRANSCRIPTION_TIMEOUT_MS: z.coerce.number().int().positive().default(60_000),
  // Janela (s) do throttle dos avisos de cortesia (áudio-falha/vazio, mídia não-suportada):
  // no máx 1 aviso por conversa/motivo por janela — anti-spam/ban-safety (§9). Dedicada
  // (não os segundos do debounce), medida em ~minuto.
  NOTICE_THROTTLE_SECONDS: z.coerce.number().int().positive().default(60),

  // ─── Email (auth transacional — 6b) ────────────────────────────────────
  // Verificação de email + reset de senha via mailer genérico (porta + fila).
  // driver: console (dev, loga código/link) | ses (prod, AWS SESv2) | noop (testes).
  AUTH_EMAIL_DELIVERY_DRIVER: z.enum(["console", "ses", "noop"]).default("console"),
  // Remetente. Domínio precisa estar verificado no SES (DKIM). Beta = msg.automato.pro.
  AUTH_EMAIL_FROM: z.string().min(1).default("AutoTraffic <no-reply@msg.automato.pro>"),
  // Região do SES de produção (só o worker envia). Creds AWS (AWS_ACCESS_KEY_ID/
  // AWS_SECRET_ACCESS_KEY) vêm da cadeia default do SDK — secret só no worker, IAM escopado.
  AWS_REGION: z.string().min(1).default("sa-east-1"),
  // TTL (min) do código OTP de verificação de email.
  AUTH_EMAIL_TOKEN_TTL_MINUTES: z.coerce.number().int().positive().default(15),
  // TTL (min) do token de reset de senha (link).
  AUTH_PASSWORD_RESET_TOKEN_TTL_MINUTES: z.coerce.number().int().positive().default(60),
  // URL pública do app — monta o link de reset (`${FRONTEND_URL}/reset-password?token=`).
  FRONTEND_URL: z.string().url().default("http://localhost:4200"),

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
