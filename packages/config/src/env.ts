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

  // ─── Storage de assets de criativo (Fatia 7) ───────────────────────────
  // driver do StoragePort: local-fs (dev) ou s3-compat (prod: MinIO/R2/B2/AWS). Trocar =
  // só este env — core/casca/ingest intocados (§5). `s3` exige os STORAGE_* abaixo (refine).
  STORAGE_DRIVER: z.enum(["local", "s3"]).default("local"),
  // diretório do blob original (driver local-fs).
  CREATIVE_STORAGE_DIR: z.string().min(1).default("./.data/creatives"),
  // base pública p/ signedUrl do adapter local (preview no site). Sem assinatura real
  // no MVP local — a URL só compõe base + ref (o arquivo é servido pela api em dev).
  CREATIVE_ASSET_URL_BASE: z.string().url().default("http://localhost:3333/assets"),
  // driver s3-compat (nomes NEUTROS — não vaza provider; MinIO/R2/B2/AWS falam o mesmo protocolo).
  // endpoint omitido = AWS S3 padrão da região; MinIO/R2 informam o endpoint + force-path-style.
  STORAGE_ENDPOINT: z.string().url().optional(),
  STORAGE_BUCKET: z.string().min(1).optional(),
  STORAGE_ACCESS_KEY: z.string().min(1).optional(),
  STORAGE_SECRET_KEY: z.string().min(1).optional(),
  STORAGE_REGION: z.string().min(1).default("us-east-1"),
  STORAGE_FORCE_PATH_STYLE: z.enum(["true", "false"]).default("true").transform((v) => v === "true"),
  // Tetos de upload de criativo (MB). Vídeo no WhatsApp tem teto MENOR (bytes vão pra memória
  // do worker via fetchMediaBase64 → OOM se grande). Web maior (streaming multipart).
  CREATIVE_MAX_IMAGE_MB: z.coerce.number().int().positive().default(15),
  CREATIVE_MAX_VIDEO_MB: z.coerce.number().int().positive().default(200),
  CREATIVE_MAX_WHATSAPP_VIDEO_MB: z.coerce.number().int().positive().default(50),

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
  // Reviewer (review_analysis) DESACOPLADO do synthesis: refina/corta (nunca inventa) →
  // tarefa mais leve, roda em modelo mais barato e não-reasoning, com schema JSON enforçado.
  // ~−75% do custo do bloco de review vs. o forte. Override por-agente em `model_config.reviewModel`.
  OPENROUTER_REVIEW_MODEL: z.string().min(1).default("google/gemini-3.7-flash"),
  OPENROUTER_VISION_MODEL: z
    .string()
    .min(1)
    .default("google/gemini-3.1-flash-lite"),
  // Map-reduce (3b-2): modelo barato por-campanha (mapa) + modelo barato do redator do
  // WhatsApp. Síntese usa OPENROUTER_MODEL (forte); reviewer usa OPENROUTER_REVIEW_MODEL. Override por-agente (Fatia 4).
  // NÃO usar modelo de reasoning aqui: o mapa é extração JSON estrita e o roteamento do
  // OpenRouter para certos providers de reasoning é lento/instável (chamadas de minutos,
  // conexão caindo) e viola o structured output → análise cai no zod e é descartada.
  // Escolha por teste real (6/6 schema-válido, ~1s, ~$0.00016/call = ~23× mais barato que o
  // gemini-flash-lite) com a MELHOR qualidade analítica do grupo testado (action types
  // corretos, budget% específico, diagnóstico de funil). Fallback: `mistralai/mistral-small-24b-instruct-2501`.
  OPENROUTER_UNIT_MODEL: z.string().min(1).default("qwen/qwen3.7-flash"),
  // Reserva do unit (OpenRouter `models` fallback): se o provider do primário falhar, roteia
  // pra cá. Provider diverso (Google × DeepSeek/Qwen), não-reasoning, barato, e enforça
  // JSON-schema — que o structured output do `map_units` exige (por isso NÃO um sem enforcement).
  OPENROUTER_UNIT_FALLBACK_MODEL: z.string().default("google/gemini-3.1-flash-lite"),
  OPENROUTER_MESSAGE_MODEL: z.string().min(1).default("google/gemini-3.1-flash-lite"),
  // Modelo p/ analisar o VÍDEO COMPLETO (movimento/áudio/gancho) enviado pelo WhatsApp — dos nossos
  // bytes, sem o desvio pela Meta. PRECISA ser video-capable (aceitar `video_url` via OpenRouter);
  // o default espelha o de mensagem, mas p/ análise de vídeo de verdade aponte pra um modelo que
  // entende vídeo (ex: Gemini 3.x pro/flash). Vídeo acima de WHATSAPP_VIDEO_MODEL_MAX_MB ou falha
  // da chamada → degradação honesta ("vídeo grande/não consegui agora; salvei na biblioteca") + a
  // análise de biblioteca sai depois. (ffmpeg-local p/ frames dos nossos bytes = fast-follow.)
  OPENROUTER_VIDEO_MODEL: z.string().min(1).default("google/gemini-3.1-flash-lite"),
  // Teto (MB) do vídeo enviado INTEIRO ao modelo — acima disso degrada (não manda ao modelo); protege
  // custo/latência/limite do modelo. O vídeo segue salvo na biblioteca. (ffmpeg-local = fast-follow.)
  WHATSAPP_VIDEO_MODEL_MAX_MB: z.coerce.number().int().positive().default(20),
  // Versão do analisador de visão — bumpar invalida o cache de análises de criativo.
  // 2 (Fatia 6c): multi-frame HD + decomposição hook/angle/format/cta.
  // 3 (Bloco 2): decomposição ganha body + proofStrength → invalida o cache antigo uma vez.
  // 4 (S4b, pivô saúde): ganha persuasionSignals (densidade de gatilhos de Cialdini, 0-7) →
  // invalida de novo (cache antigo não tem o campo pro guard de weak_creative funcionar).
  CREATIVE_VISION_ANALYZER_VERSION: z.coerce.number().int().positive().default(4),
  // Frames HD por criativo de vídeo enviados à visão (espaçados; imagem = 1). Fatia 6c.
  ANALYSIS_VISION_FRAMES: z.coerce.number().int().positive().default(4),
  LLM_COST_CAP_USD_PER_PERIOD: z.coerce.number().min(0).default(0),
  // Retentativas in-process por chamada de LLM (429/5xx/rede/passthrough do provider).
  LLM_MAX_RETRIES: z.coerce.number().int().nonnegative().default(3),
  // Timeout por tentativa HTTP ao OpenRouter (ms). Sem isto o `fetch` do Node espera
  // pra sempre: uma call que trava no provider pendura o run inteiro (reaper não pega —
  // o lock do worker segue vivo). Ao estourar, vira erro de rede → retryable → reroteia.
  LLM_HTTP_TIMEOUT_MS: z.coerce.number().int().positive().default(120000),
  // Retentativas de PARSE/validação do structured output (JSON inválido, truncado ou
  // que falha o schema zod). Separado do retry de rede — re-chama o LLM p/ obter um JSON
  // válido em vez de descartar a análise em silêncio.
  LLM_STRUCTURED_MAX_RETRIES: z.coerce.number().int().nonnegative().default(2),
  // Timeout por chamada HTTP ao LLM no CHAT (ms) — DEVE ser < CONVERSATION_TURN_TIMEOUT_MS
  // p/ o timeout+retry agir DENTRO do turno (senão o teto do turno corta antes e vira o
  // fallback). Chat é rápido (flash + tools = segundos); 45s pega hang e sobra p/ 1 reroute.
  CONVERSATION_HTTP_TIMEOUT_MS: z.coerce.number().int().positive().default(45000),
  // Revisor (Analista→Revisor) ligado por padrão; default global — override por-agente
  // em `agents.model_config.reviewEnabled` (Fatia 4).
  ANALYSIS_REVIEW_ENABLED: z.enum(["true", "false"]).default("true").transform((v) => v === "true"),
  // Teto de tokens de SAÍDA por chamada de LLM (controla custo/trunca). Override por-agente.
  // Folga p/ reasoning + JSON caberem juntos (modelos que "pensam" gastam saída antes da resposta).
  ANALYSIS_MAX_OUTPUT_TOKENS: z.coerce.number().int().positive().default(8000),
  // Esforço de reasoning da SÍNTESE (unit é sempre `off`, hardcoded). `off` desliga.
  // Override por-agente em `agents.model_config.reasoningEffort` (Fatia 4).
  ANALYSIS_REASONING_EFFORT: z.enum(["off", "low", "medium", "high"]).default("medium"),
  // Esforço de reasoning do REVISOR — separado da síntese (achado do A/B real grok×gemini:
  // revisor refina/corta, não gera do zero; `medium` compartilhado pagava reasoning
  // desproporcional pro escopo da tarefa). Override por-agente em
  // `agents.model_config.reviewReasoningEffort` (Fatia 4). Default `off`.
  ANALYSIS_REVIEW_REASONING_EFFORT: z.enum(["off", "low", "medium", "high"]).default("off"),
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
  // Timeout (ms) por chamada HTTP à Graph API — sem isso, um fetch preso (rede)
  // trava o run/turno esperando pra sempre (nunca dá erro, só não responde).
  META_HTTP_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),

  // ─── WhatsApp (Evolution) ──────────────────────────────────────────────
  // Nível OPERADOR (compartilhado): 1 servidor Evolution hospeda as instâncias
  // de todos os clientes. Base URL + API key global (admin) = env.
  EVOLUTION_BASE_URL: z.string().url(),
  EVOLUTION_API_KEY: z.string().min(1, "EVOLUTION_API_KEY é obrigatória"),
  // Timeout (ms) por chamada HTTP à Evolution — sem isso, um fetch preso (ex:
  // group/fetchAllGroups devagar/travado) fica "buscando pra sempre" na UI, nunca
  // dá erro (mesmo raciocínio do META_HTTP_TIMEOUT_MS acima).
  EVOLUTION_HTTP_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
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
  // TTL do cache (Redis) do CATÁLOGO de comportamentos (behaviors) — taxonomia GLOBAL locale-scoped
  // (não varia por conta), sem busca no servidor → fetch da lista + match local. Default ~7 dias. `0` desliga.
  META_BEHAVIOR_CACHE_TTL_SEC: z.coerce.number().int().min(0).default(604800),
  // Frescura (6a): idade máx. (min) do snapshot mais novo antes de disparar sync-only
  // (porta `shouldSync`, compartilhada por sweep/lazy/análise/botão). Também = intervalo
  // do sweep periódico. ~2-3h de default (equilíbrio frescura × chamadas Meta).
  INSIGHTS_FRESH_THRESHOLD_MIN: z.coerce.number().int().positive().default(120),
  // Breakdown demográfico/posicionamento (S7, pivô saúde) — cadência PRÓPRIA, bem mais
  // lenta que o sync diário (o spread muda devagar): default 7 dias. Mesma família de
  // INSIGHTS_FRESH_THRESHOLD_MIN acima (staleness de sync Meta), prefixo consistente.
  INSIGHTS_BREAKDOWN_STALE_THRESHOLD_MIN: z.coerce.number().int().positive().default(7 * 24 * 60),
  // Dormância (pivô): dias sem atividade (spend/impressões) p/ a conta virar dormante
  // (backoff do cron); e o intervalo LENTO de varredura do sweep p/ contas dormantes
  // (detecta a reativação em ~1 dia sem queimar chamadas Meta à toa).
  DORMANT_AFTER_DAYS: z.coerce.number().int().positive().default(7),
  DORMANT_SWEEP_INTERVAL_MIN: z.coerce.number().int().positive().default(1440),
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
  // Piso de elegibilidade RELATIVO (playbook real, pivô saúde): gasto ≥ este múltiplo
  // do CPA-alvo já basta como volume, mesmo com poucas conversões/cliques absolutos.
  ANALYSIS_QUALITY_RELATIVE_ELIGIBILITY_SPEND_MULTIPLIER: z.coerce.number().positive().default(2),
  // CPA marginal (pivô saúde, squad): alta (%) do CPA vs baseline a partir da qual rebaixa
  // escalar → investigar, mesmo pra quem ainda bate a meta em média.
  ANALYSIS_QUALITY_MARGINAL_CPA_WORSEN_PCT: z.coerce.number().positive().default(20),
  // Retenção de vídeo (S6, %) abaixo disso = gancho fraco na largada (25% do vídeo).
  ANALYSIS_QUALITY_WEAK_HOOK_RETENTION_MAX_PCT: z.coerce.number().positive().default(50),

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

  // ─── Aprendizado contínuo ──────────────────────────────────────────────
  // Cadência do job de aprendizado (cron 5-campos) — destila/mede/cura 1x/dia.
  AGENT_LEARNING_CRON: z.string().min(1).default("0 6 * * *"), // 06:00 diário
  // Quantos runs recentes do agente entram na destilação observacional (histórico).
  LEARNING_HISTORY_RUNS: z.coerce.number().int().positive().default(10),
  // Mínimo de runs no histórico p/ arriscar um padrão (evita ruído de 1-2 análises).
  LEARNING_MIN_RUNS: z.coerce.number().int().positive().default(3),
  // Fração dos runs que precisa exibir o padrão p/ ele valer (0-1).
  LEARNING_MIN_OCCURRENCE_RATIO: z.coerce.number().min(0).max(1).default(0.6),
  // Teto de lições ATIVAS injetadas no brief (disciplina do brief — nunca o firehose).
  LEARNING_BRIEF_TOP_K: z.coerce.number().int().positive().default(5),
  // Buffer (dias) da learning phase da Meta antes de medir outcome de uma ação (S4).
  LEARNING_PHASE_BUFFER_DAYS: z.coerce.number().int().nonnegative().default(7),
  // Janela (dias) de medição do outcome depois do buffer (S4).
  LEARNING_OUTCOME_WINDOW_DAYS: z.coerce.number().int().positive().default(7),
  // Teto de CRIAÇÃO de lições por tick do job (throttle a rajadas; o texto é determinístico).
  LEARNING_MAX_NEW_LESSONS_PER_TICK: z.coerce.number().int().positive().default(20),
  // Dias sem reforço p/ uma lição virar `stale` e depois `archived` (S2 decay).
  LEARNING_DECAY_STALE_DAYS: z.coerce.number().int().positive().default(30),
  LEARNING_DECAY_ARCHIVE_DAYS: z.coerce.number().int().positive().default(60),
  // Decaimento do CONFIRMADO — relógio LONGO (aposentadoria por evidência): o dono endossou, mas
  // se a conta parar de reforçar por muito tempo, a lição cede em vez de acumular pra sempre.
  LEARNING_CONFIRMED_STALE_DAYS: z.coerce.number().int().positive().default(90),
  LEARNING_CONFIRMED_ARCHIVE_DAYS: z.coerce.number().int().positive().default(180),
  // Mínimo de ENTIDADES DISTINTAS que precisam sustentar um par (dimensão,direção) p/
  // nascer um prior de CONTA (v3 — destilação cross-seccional; repetir a mesma não conta).
  LEARNING_ACCOUNT_MIN_ENTITIES: z.coerce.number().int().positive().default(3),
  // Janela (dias) da série de insights lida pelos detectores TEMPORAIS (fadiga/lag, Classe B).
  LEARNING_TEMPORAL_LOOKBACK_DAYS: z.coerce.number().int().positive().default(60),
  // R$ mínimo/dia (unidade MENOR da moeda) bloqueado pelo teto de budget p/ valer o aviso de
  // oportunidade de guardrail (v3) — abaixo disso não incomoda o usuário. Default: R$10/dia.
  LEARNING_OPPORTUNITY_MIN_MATERIAL_MINOR: z.coerce.number().int().nonnegative().default(1000),
  // Dias de cooldown ao DISPENSAR o aviso de oportunidade (some da zona por esse tempo).
  LEARNING_ADVISORY_DISMISS_COOLDOWN_DAYS: z.coerce.number().int().positive().default(14),

  // ─── Conversa (WhatsApp — Grafo B ReAct, 5b-2) ─────────────────────────
  // Modelo do chat: fallback quando o agente não tem `model_config.messageModel`.
  // Chat = alto volume + tarefa simples → default barato com bom tool-calling. First-party
  // (OpenAI): shape de resposta estável. Trocado do gemini-3.7-flash, que retornava choices
  // vazio de forma intermitente → BaseChatModel.invoke do LangChain estourava TypeError.
  CONVERSATION_MODEL: z.string().min(1).default("openai/gpt-5.6-luna"),
  // Reserva do chat: se o primário esgotar o retry/backoff (blip do provider), tenta este
  // (TAMBÉM com retry/backoff). Provider DIVERSO do primário (OpenAI × Google) — testado com
  // tools + histórico real. Vazio = sem reserva.
  CONVERSATION_FALLBACK_MODEL: z.string().default("openai/gpt-4.1-mini"),
  // Janela de contexto por TURNO enviada ao LLM (turno = fala do usuário + resposta
  // completa até a próxima fala; nunca quebra par tool_call/tool_result).
  CONVERSATION_HISTORY_TURNS: z.coerce.number().int().positive().default(8),
  // Teto de tokens (aprox., por chars) da janela — 2ª rede sobre turnos "gordos".
  CONVERSATION_MAX_TOKENS: z.coerce.number().int().positive().default(6000),
  // Debounce do inbound: coalesce mensagens picadas do mesmo contato num turno só.
  CONVERSATION_DEBOUNCE_SECONDS: z.coerce.number().int().nonnegative().default(5),
  // Teto (ms) do turno inteiro (ReAct: LLM + tools, pode chamar a Meta ao vivo via
  // get_fresh_metrics). Travamento sem erro → cai no fallback amigável, nunca deixa
  // o usuário sem resposta pra sempre.
  CONVERSATION_TURN_TIMEOUT_MS: z.coerce.number().int().positive().default(90_000),
  // Teto (ms) do fetch AO VIVO da Meta dentro de uma read-tool do chat (ex: get_top_creatives
  // fresh=true refresca copies). DEVE ser < CONVERSATION_TURN_TIMEOUT_MS: se a Meta demora, a
  // tool degrada pro dado persistido em vez de estourar o turno inteiro (a causa do fallback
  // genérico quando o refresh de todos os criativos levava minutos).
  CHAT_LIVE_FETCH_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
  // Teto (ms) do fetch AO VIVO da Meta na leitura de campanhas da API (site) — achado real:
  // campanha nova/ativa criada depois do último run não aparecia na lista (só entity_analyses,
  // que só atualiza em run). Curto de propósito: é dentro de uma resposta HTTP síncrona, não de
  // um turno de chat — timeout/erro degrada em silêncio (a lista cacheada já tinha o resto).
  RUNS_LIVE_GAP_CHECK_TIMEOUT_MS: z.coerce.number().int().positive().default(4_000),
  // Modelo default da geração de COPY do rascunho (Fatia 7) quando o agente não tem modelo
  // próprio (model_config.messageModel/model). Env em vez de hardcoded — mesmo padrão dos
  // modelos de análise. Tarefa de escrita curta e barata.
  COPY_MODEL: z.string().min(1).default("openai/gpt-4o-mini"),

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
  // Kill-switch de PLATAFORMA do ingest de contexto de grupo: mensagens que NÃO dirigem
  // o bot (sem @menção/reply) são guardadas como CONTEXTO (transcript ambiente) por padrão
  // quando a org tem grupo registrado. Desligar aqui corta o ingest para todas as orgs.
  // Controle org-facing = fast-follow. Reter/expirar via GROUP_CONTEXT_RETENTION_DAYS.
  // enum (não z.coerce.boolean): "false" coage p/ true em Boolean() — o kill-switch NÃO
  // desligaria. Mesmo padrão dos demais booleanos do arquivo.
  TRAFEGO_GROUP_INGEST_CONTEXT: z.enum(["true", "false"]).default("true").transform((v) => v === "true"),
  // Retenção (dias) do dado ambiente de grupo (purge job diário). Contexto usa só o
  // recente, mas o dono optou por manter alinhado à retenção de insights (~90d).
  GROUP_CONTEXT_RETENTION_DAYS: z.coerce.number().int().positive().default(90),
  // Transcript ambiente injetado no prompt (só em turno de grupo dirigido): teto de
  // mensagens, janela de tempo e teto de tokens. Separados da janela do state.messages.
  GROUP_CONTEXT_MAX_MESSAGES: z.coerce.number().int().positive().default(25),
  GROUP_CONTEXT_WINDOW_HOURS: z.coerce.number().int().positive().default(24),
  GROUP_CONTEXT_MAX_TOKENS: z.coerce.number().int().positive().default(1500),
  // Staleness do foco de conta (org multi-conta): foco cujo último uso passou desse TTL
  // perde precedência — no grupo cai no contexto ambiente, na DM cai em "qual conta?".
  CONVERSATION_FOCUS_TTL_HOURS: z.coerce.number().int().positive().default(12),
  // Cron do purge do contexto ambiente de grupo (retenção/LGPD) — diário (default 04:00).
  GROUP_CONTEXT_PURGE_CRON: z.string().min(1).default("0 4 * * *"),
  // TTL (s) do cache do mapa LID→telefone dos participantes de um grupo — resolve
  // menção/reply endereçada por LID (grupo migrado, WhatsApp addressingMode "lid")
  // quando o telefone de quem foi mencionado/citado não vem direto no payload da
  // mensagem. Participação de grupo muda pouco; folgado (~1h) é seguro.
  GROUP_PARTICIPANTS_CACHE_TTL_SEC: z.coerce.number().int().positive().default(3600),
  // Kill-switch de PLATAFORMA da escrita conversacional de ads pelo chat. Default ON (o gestor
  // autora/edita/muta a Meta por conversa: pausar/orçamento/status/realocar/editar público/criar/
  // copiar/escalar + o "sim" que cria via criativo enviado), sempre atrás de eco+confirma +
  // guardrail + nunca-auto nas ações de risco. Habilitado após a bateria adversarial de eco+confirma
  // passar (D1): roteamento anti-auto-apply (nenhuma escrita vai direto pro apply), saga de
  // realocação com compensação, e `adjust_audience`/ressalva nunca auto (core). Cada capacidade
  // ainda é gated por binding (`agent_tool_bindings`/`allowedActions`): as mutações seguem
  // `allowedActions` (default só `pause_entity`, `dryRun:true`), **editar público**
  // (`adjust_audience`) é opt-in (default OFF), e **criar/escalar** nascem default-ON — mas toda
  // criação nasce PAUSADA + 2ª aprovação de ativação, sob eco+confirma, então o blast radius
  // default é rascunho pausado/simulado. OFF ("false") = desliga TODA a escrita conversacional (só
  // consulta + aprovar/rejeitar + revert + auto-config; autonomia/proativo/site intactos) — o freio
  // de emergência. enum (não z.coerce.boolean): "false" coage p/ true em Boolean(). Mesmo padrão
  // dos demais booleanos do arquivo.
  TRAFEGO_CHAT_ADS_WRITES: z.enum(["true", "false"]).default("true").transform((v) => v === "true"),

  // ─── Email (auth transacional — 6b) ────────────────────────────────────
  // Verificação de email + reset de senha via mailer genérico (porta + fila).
  // driver: console (dev, loga código/link) | ses (prod, AWS SESv2) | noop (testes).
  AUTH_EMAIL_DELIVERY_DRIVER: z.enum(["console", "ses", "noop"]).default("console"),
  // Remetente. Domínio precisa estar verificado no SES (DKIM). Beta = msg.automato.pro.
  AUTH_EMAIL_FROM: z.string().min(1).default("CaquiAI <no-reply@msg.automato.pro>"),
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
}).superRefine((v, ctx) => {
  // driver s3 exige bucket + credenciais (fail-fast no boot; sem eles o adapter quebraria em runtime).
  if (v.STORAGE_DRIVER === "s3") {
    for (const key of ["STORAGE_BUCKET", "STORAGE_ACCESS_KEY", "STORAGE_SECRET_KEY"] as const) {
      if (!v[key]) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: [key], message: "obrigatório quando STORAGE_DRIVER=s3" });
      }
    }
  }
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
