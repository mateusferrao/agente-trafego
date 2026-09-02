// Composition root MANUAL do worker (sem DI container), espelhando apps/api.
// Instancia adapters concretos, resolve ports e injeta db/logger. Nada aqui é
// importado pelo core (`@trafego/core` só conhece interfaces de `@trafego/shared`).

import type {
  AdsPlatformPort,
  ApprovalPort,
  CredentialVaultPort,
  LLMProviderPort,
  MailerPort,
  MessagingChannelPort,
  MeteringPort,
  SchedulerPort,
  TranscriptionPort,
  StoragePort,
} from "@trafego/shared/ports";
import { WHATSAPP_TRANSCRIPTION_ATTEMPTS, WHATSAPP_TRANSCRIPTION_BACKOFF_MS } from "@trafego/shared";
import type { Database } from "@trafego/db/client";
import { createDb } from "@trafego/db";
import { loadEnv, resolveDataDir } from "@trafego/config";
import { BUFFER_TTL_MARGIN_SEC } from "./modules/conversation/buffer.js";
import { createLocalStorage } from "@trafego/storage-local";
import { createS3Storage } from "@trafego/storage-s3";
import { Aes256CredentialVault } from "@trafego/credential-vault";
import { BullmqScheduler } from "@trafego/scheduler-bullmq";
import { CustomConversionsResolver, MetaAdsAdapter, MetaBehaviorCatalogService, MetaEntityCache, MetaGraphClient, MetaGovernor } from "@trafego/ads-meta";
import { EvolutionAdapter, EvolutionClient } from "@trafego/channel-evolution";
import { OpenRouterAdapter, OpenRouterClient } from "@trafego/llm-openrouter";
import { OpenRouterTranscriptionAdapter } from "@trafego/transcription-openrouter";
import { createPostgresApprovals } from "@trafego/approval-postgres";
import { createPostgresMetering, withLlmMetering } from "@trafego/metering-postgres";
import { createMailer } from "@trafego/mailer";
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import type { BaseCheckpointSaver } from "@langchain/langgraph";
import { Redis } from "ioredis";
import { pino, type Logger } from "pino";
import { createDrizzleInsightsSnapshotsRepo } from "./modules/insights/repo.js";
import { createInsightsSyncService, type InsightsSyncService } from "./modules/insights/sync-service.js";
import { createDrizzleInsightsBreakdownsRepo } from "./modules/insights/breakdown-repo.js";
import { createBreakdownSyncService, type BreakdownSyncService } from "./modules/insights/breakdown-sync-service.js";

/**
 * Container de dependências resolvidas. Passado por injeção para grafos,
 * nós, executores e workers — nunca acessado via singleton global.
 */
export interface WorkerDeps {
  readonly db: Database;
  readonly logger: Logger;
  /** conexão Redis dos adapters/governor/scheduler — fechada no shutdown. */
  readonly redis: Redis;
  readonly ports: {
    readonly ads: AdsPlatformPort;
    readonly messaging: MessagingChannelPort;
    readonly llm: LLMProviderPort;
    readonly vault: CredentialVaultPort;
    readonly scheduler: SchedulerPort;
    readonly metering: MeteringPort;
    readonly approval: ApprovalPort;
    /** Entrega de email transacional (6b) — só o worker envia (consumidor da fila). */
    readonly mailer: MailerPort;
    /** Transcrição de nota de voz inbound (STT) — worker é o dono (API stuba o LLM). */
    readonly transcription: TranscriptionPort;
    /** Storage do blob original de criativo (F7 intake) — local-fs no MVP, S3-compat depois. */
    readonly storage: StoragePort;
  };
  /** Sync de insights (2a): coleta a série temporal Meta → insights_snapshots. */
  readonly insightsSync: InsightsSyncService;
  /** Sync de breakdown demográfico/posicionamento (S7, pivô saúde) — cadência própria. */
  readonly breakdownSync: BreakdownSyncService;
  /** Config da análise (3a/3b) — defaults globais de produto (env; override por-agente). */
  readonly analysis: import("./modules/analysis/config.js").AnalysisDefaults;
  /** Frescura (6a): limite de staleness (min) do sync-only + intervalo do sweep. */
  readonly insights: {
    readonly freshThresholdMin: number;
  };
  /** Dormância (pivô): dias sem atividade p/ dormir + intervalo lento do sweep dormante. */
  readonly dormancy: {
    readonly afterDays: number;
    readonly sweepIntervalMin: number;
  };
  /** Intake de criativo (F7): teto de vídeo no WhatsApp (bytes → memória do worker). */
  readonly creative: {
    readonly maxWhatsappVideoBytes: number;
  };
  /** Origem do site p/ deep-link nas mensagens de WhatsApp. */
  readonly webOrigin: string;
  /** Versão do analisador de visão (chave do cache de criativos — bump invalida). */
  readonly visionAnalyzerVersion: number;
  /** Config da cadência/cron (3b) — defaults globais (env; cadência por-agente na Fatia 4). */
  readonly cron: {
    readonly defaultCron: string;
    readonly tz: string;
    readonly jitterMs: number;
  };
  /** Config do reaper de runs presos (3b) — libera o índice in-flight após crash. */
  readonly reaper: {
    readonly staleMinutes: number;
    readonly cron: string;
  };
  /** Cadência da expiração de aprovações (5b) — varre pendentes vencidas (24h). */
  readonly approvalExpiryCron: string;
  readonly groupContextPurgeCron: string;
  /** Cadência do job de aprendizado (cron) — destila/mede/cura 1x/dia. */
  readonly agentLearningCron: string;
  /** Aprendizado contínuo — parâmetros globais (env; overrides por-agente em fatias seguintes). */
  readonly learning: {
    readonly historyRuns: number;
    readonly minRuns: number;
    readonly minOccurrenceRatio: number;
    readonly briefTopK: number;
    readonly redactorModel: string;
    readonly redactorMaxPerTick: number;
    readonly phaseBufferDays: number;
    readonly outcomeWindowDays: number;
    readonly decayStaleDays: number;
    readonly decayArchiveDays: number;
    readonly accountMinEntities: number;
    readonly temporalLookbackDays: number;
    readonly opportunityMinMaterialMinor: number;
  };
  /** Cap default global de custo LLM por org/período (env). Cap por-org = guardrail_configs. */
  readonly costCapUsd: number;
  /** Config do chat do WhatsApp (Grafo B ReAct, 5b-2). Modelo = fallback (agente vence). */
  readonly conversation: {
    readonly model: string;
    readonly apiKey: string;
    readonly baseUrl: string;
    readonly historyTurns: number;
    readonly maxTokens: number;
    readonly debounceSeconds: number;
    /** Janela (s) do throttle dos avisos de cortesia — dedicada (não o debounce). */
    readonly noticeThrottleSec: number;
    /** Teto (ms) do turno inteiro (ReAct) — travamento sem erro cai no fallback. */
    readonly turnTimeoutMs: number;
    /** Teto (ms) do fetch ao vivo da Meta numa read-tool — degrada pro persistido (< turnTimeout). */
    readonly liveFetchTimeoutMs: number;
    /** Timeout por chamada HTTP ao LLM (ms) — evita hang no provider até o teto do turno. */
    readonly httpTimeoutMs: number;
    /** Retentativas por chamada de LLM (rede/429/5xx) — reroteia o provider ruim. */
    readonly maxRetries: number;
    /** modelo de RESERVA do chat — se o primário esgotar o retry, tenta este (também com retry). */
    readonly fallbackModel: string;
    /** modelo default da geração de copy do rascunho (Fatia 7) — override por-agente no model_config. */
    readonly copyModel: string;
    /** Fallback de custo (bug do bindTools suprimindo usage.cost — ver nodes.ts). */
    readonly fetchGenerationCost: (generationId: string) => Promise<number | undefined>;
    /** Kill-switch de plataforma do ingest de contexto de grupo (default: ligado). */
    readonly groupIngestContext: boolean;
    /** Kill-switch de plataforma da escrita conversacional de ads pelo chat (v1: default OFF).
     *  OFF → o chat não autora/edita/muta a Meta; consulta/aprovação/config seguem. */
    readonly chatAdsWrites: boolean;
    /** Retenção (dias) do dado ambiente de grupo (purge job diário). */
    readonly groupContextRetentionDays: number;
    /** Transcript ambiente injetado no prompt: teto de mensagens / janela (h) / teto de tokens. */
    readonly groupContextMaxMessages: number;
    readonly groupContextWindowHours: number;
    readonly groupContextMaxTokens: number;
    /** Staleness do foco de conta (h): foco cujo último uso passou disso perde precedência. */
    readonly focusTtlHours: number;
    /** TTL (s) do cache do mapa LID→telefone dos participantes de um grupo (resolve
     *  menção/reply endereçada por LID quando o telefone não vem direto na mensagem). */
    readonly groupParticipantsCacheTtlSec: number;
  };
  /** Config da transcrição de áudio inbound (STT). Modelo vive no adapter. */
  readonly transcription: {
    /** dica ISO-639-1 (ex: "pt"); vazio = auto-detect do provider. */
    readonly language: string;
    /** teto de tamanho do áudio (MB) — acima disso, aviso amigável sem transcrever. */
    readonly maxAudioMb: number;
    /** provider p/ o metering (nome vem daqui, não literal no worker genérico — §13). */
    readonly provider: string;
    /** TTL (s) da flag `wa:transcribing` — cobre todas as tentativas + backoff + margem. */
    readonly transcribingTtlSec: number;
  };
  /** Checkpointer do LangGraph (Postgres) — memória durável do chat (Grafo B, 5b-2). */
  readonly checkpointer: BaseCheckpointSaver;
}

export interface CompositionConfig {
  readonly databaseUrl: string;
  readonly redisUrl: string;
}

/**
 * Monta o grafo de dependências do worker. Ordem: infra (db/redis/logger) →
 * vault → adapters de plataforma/canal/llm → ports de scheduler/metering/approval
 * → checkpointer LangGraph.
 */
export async function buildComposition(): Promise<WorkerDeps> {
  const env = loadEnv();
  const logger = pino({
    level: env.LOG_LEVEL,
    // nunca logar o token em claro (joia da coroa) — redige campos sensíveis (inclui aninhados).
    redact: ["token", "accessToken", "tokenCripto", "*.token", "*.accessToken", "*.tokenCripto"],
  });
  const db = createDb(env.DATABASE_URL);
  // conexão dedicada aos adapters/governor (separada da conexão dos Workers BullMQ).
  const redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });

  const vault = new Aes256CredentialVault(env.CREDENTIAL_MASTER_KEY, env.CREDENTIAL_KEY_VERSION);
  const client = new MetaGraphClient({ timeoutMs: env.META_HTTP_TIMEOUT_MS });
  const governor = new MetaGovernor({ redis });
  const ads = new MetaAdsAdapter({
    client,
    governor,
    customConversions: new CustomConversionsResolver({
      client,
      redis,
      ttlSec: env.CUSTOM_CONVERSIONS_CACHE_TTL_SEC,
    }),
    // cache do catálogo de entidades entre runs (corta o listEntities full = rate-limit).
    entityCache: new MetaEntityCache({ redis, ttlSec: env.META_ENTITY_CACHE_TTL_SEC }),
    // catálogo de behaviors (enum global sem busca) cacheado locale-scoped no Redis.
    behaviorCatalog: new MetaBehaviorCatalogService(client, governor, { redis, ttlSec: env.META_BEHAVIOR_CACHE_TTL_SEC }),
    visionFrames: env.ANALYSIS_VISION_FRAMES,
  });
  const insightsSync = createInsightsSyncService({
    ads,
    repo: createDrizzleInsightsSnapshotsRepo(db),
    refetchWindowDays: env.INSIGHTS_REFETCH_WINDOW_DAYS,
    retentionDays: env.INSIGHTS_RETENTION_DAYS,
  });
  const breakdownSync = createBreakdownSyncService({
    ads,
    repo: createDrizzleInsightsBreakdownsRepo(db),
    staleThresholdMin: env.INSIGHTS_BREAKDOWN_STALE_THRESHOLD_MIN,
  });
  const messaging = new EvolutionAdapter({
    client: new EvolutionClient({
      baseUrl: env.EVOLUTION_BASE_URL,
      apiKey: env.EVOLUTION_API_KEY,
      timeoutMs: env.EVOLUTION_HTTP_TIMEOUT_MS,
    }),
  });
  const scheduler = new BullmqScheduler(redis);
  // Metering (3b): grava usage_events (custo real por chamada). O LLM é envolvido
  // pelo decorator de metering (cross-cutting num lugar só — §13; atribui por meta).
  const metering = createPostgresMetering(db);
  const openRouterClient = new OpenRouterClient({
    apiKey: env.OPENROUTER_API_KEY,
    baseUrl: env.OPENROUTER_BASE_URL,
    maxRetries: env.LLM_MAX_RETRIES,
    requestTimeoutMs: env.LLM_HTTP_TIMEOUT_MS,
    logger, // observa retries + troca de modelo (pontos de falha)
    referer: env.WEB_ORIGIN,
    title: "CaquiAI",
  });
  const llm = withLlmMetering(
    new OpenRouterAdapter({ client: openRouterClient, structuredMaxRetries: env.LLM_STRUCTURED_MAX_RETRIES, logger }),
    { metering, provider: "openrouter", onError: (err) => logger.warn({ err }, "metering:falhou") },
  );
  // Transcrição de nota de voz inbound (STT via OpenRouter, endpoint /audio/transcriptions).
  // Custo real vai ao metering manualmente no worker de transcrição (S4).
  const transcription = new OpenRouterTranscriptionAdapter({
    apiKey: env.OPENROUTER_API_KEY,
    baseUrl: env.OPENROUTER_BASE_URL,
    model: env.TRANSCRIPTION_MODEL,
    timeoutMs: env.TRANSCRIPTION_TIMEOUT_MS,
  });
  // TTL da flag `wa:transcribing` = todas as tentativas (timeout) + backoff acumulado +
  // margem. Backstop: se um job sumir sem baixar a flag, ela expira e o flush destrava.
  const transcribingTtlSec =
    Math.ceil(env.TRANSCRIPTION_TIMEOUT_MS / 1000) * WHATSAPP_TRANSCRIPTION_ATTEMPTS +
    Math.ceil(WHATSAPP_TRANSCRIPTION_BACKOFF_MS / 1000) * WHATSAPP_TRANSCRIPTION_ATTEMPTS +
    BUFFER_TTL_MARGIN_SEC;

  // checkpointer do chat (Grafo B, 5b-2): memória durável por conversa (thread).
  // setup() cria as tabelas de checkpoint (idempotente) no boot.
  const checkpointer = PostgresSaver.fromConnString(env.DATABASE_URL);
  await checkpointer.setup();

  return {
    db,
    logger,
    redis,
    ports: {
      ads,
      messaging,
      vault,
      scheduler,
      llm, // plugada na 3a (análise) + metering na 3b (decorator)
      metering, // plugada na 3b (Postgres usage_events)
      approval: createPostgresApprovals(db),
      // email transacional (6b): SES em prod, console em dev. Creds AWS via env (só worker).
      mailer: createMailer({
        driver: env.AUTH_EMAIL_DELIVERY_DRIVER,
        region: env.AWS_REGION,
        log: (m) => logger.info(m),
      }),
      transcription, // STT da nota de voz inbound (S3)
      // driver por env: local-fs (dev) ou s3-compat (prod) — mesma porta, core/ingest intocados (§5).
      storage:
        env.STORAGE_DRIVER === "s3"
          ? createS3Storage({
              region: env.STORAGE_REGION,
              bucket: env.STORAGE_BUCKET!, // garantido pelo refine (STORAGE_DRIVER=s3)
              accessKeyId: env.STORAGE_ACCESS_KEY!,
              secretAccessKey: env.STORAGE_SECRET_KEY!,
              forcePathStyle: env.STORAGE_FORCE_PATH_STYLE,
              ...(env.STORAGE_ENDPOINT ? { endpoint: env.STORAGE_ENDPOINT } : {}),
            })
          : createLocalStorage({ baseDir: resolveDataDir(env.CREATIVE_STORAGE_DIR), urlBase: env.CREATIVE_ASSET_URL_BASE }),
    },
    insightsSync,
    breakdownSync,
    analysis: {
      model: env.OPENROUTER_MODEL,
      reviewModel: env.OPENROUTER_REVIEW_MODEL,
      unitModel: env.OPENROUTER_UNIT_MODEL,
      unitFallbackModels: env.OPENROUTER_UNIT_FALLBACK_MODEL ? [env.OPENROUTER_UNIT_FALLBACK_MODEL] : [],
      messageModel: env.OPENROUTER_MESSAGE_MODEL,
      visionModel: env.OPENROUTER_VISION_MODEL,
      windowDays: env.ANALYSIS_WINDOW_DAYS,
      baselineDays: env.ANALYSIS_BASELINE_DAYS,
      topN: env.ANALYSIS_TOP_N,
      reviewEnabled: env.ANALYSIS_REVIEW_ENABLED,
      maxOutputTokens: env.ANALYSIS_MAX_OUTPUT_TOKENS,
      reasoningEffort: env.ANALYSIS_REASONING_EFFORT,
      reviewReasoningEffort: env.ANALYSIS_REVIEW_REASONING_EFFORT,
      maxCreativesVision: env.ANALYSIS_MAX_CREATIVES_VISION,
      notableAdsPerCampaign: env.ANALYSIS_NOTABLE_ADS_PER_CAMPAIGN,
      maxCreativesVisionPerCampaign: env.ANALYSIS_MAX_CREATIVES_VISION_PER_CAMPAIGN,
      mapConcurrency: env.ANALYSIS_MAP_CONCURRENCY,
      executionPolicy: env.ANALYSIS_EXECUTION_POLICY,
      deepIntervalDays: env.ANALYSIS_DEEP_INTERVAL_DAYS,
      materialChangePct: env.ANALYSIS_MATERIAL_CHANGE_PCT,
      quality: {
        minConversions: env.ANALYSIS_QUALITY_MIN_CONVERSIONS,
        minClicks: env.ANALYSIS_QUALITY_MIN_CLICKS,
        fatigueCtrDropPct: env.ANALYSIS_QUALITY_FATIGUE_CTR_DROP_PCT,
        fatigueFrequency: env.ANALYSIS_QUALITY_FATIGUE_FREQUENCY,
        frequencyCapByStage: {
          prospecting: env.ANALYSIS_QUALITY_FREQUENCY_CAP_PROSPECTING,
          remarketing: env.ANALYSIS_QUALITY_FREQUENCY_CAP_REMARKETING,
        },
        fatigueCostRisePct: env.ANALYSIS_QUALITY_FATIGUE_COST_RISE_PCT,
        zombieMinSpend: env.ANALYSIS_QUALITY_ZOMBIE_MIN_SPEND,
        coldStartReference: env.ANALYSIS_QUALITY_COLD_START_REFERENCE,
        trackingBrokenRatio: env.ANALYSIS_QUALITY_TRACKING_BROKEN_RATIO,
        trackingBrokenMinFunnel: env.ANALYSIS_QUALITY_TRACKING_BROKEN_MIN_FUNNEL,
        relativeEligibilitySpendMultiplier: env.ANALYSIS_QUALITY_RELATIVE_ELIGIBILITY_SPEND_MULTIPLIER,
        marginalCpaWorsenPct: env.ANALYSIS_QUALITY_MARGINAL_CPA_WORSEN_PCT,
        weakHookRetentionMaxPct: env.ANALYSIS_QUALITY_WEAK_HOOK_RETENTION_MAX_PCT,
      },
    },
    insights: {
      freshThresholdMin: env.INSIGHTS_FRESH_THRESHOLD_MIN,
    },
    dormancy: {
      afterDays: env.DORMANT_AFTER_DAYS,
      sweepIntervalMin: env.DORMANT_SWEEP_INTERVAL_MIN,
    },
    creative: {
      maxWhatsappVideoBytes: env.CREATIVE_MAX_WHATSAPP_VIDEO_MB * 1024 * 1024,
    },
    webOrigin: env.WEB_ORIGIN,
    visionAnalyzerVersion: env.CREATIVE_VISION_ANALYZER_VERSION,
    cron: {
      defaultCron: env.ANALYSIS_CRON_DEFAULT,
      tz: env.ANALYSIS_TZ,
      jitterMs: env.ANALYSIS_CRON_JITTER_MS,
    },
    reaper: {
      staleMinutes: env.ANALYSIS_RUN_STALE_MINUTES,
      cron: env.ANALYSIS_REAPER_CRON,
    },
    approvalExpiryCron: env.APPROVAL_EXPIRY_CRON,
    groupContextPurgeCron: env.GROUP_CONTEXT_PURGE_CRON,
    agentLearningCron: env.AGENT_LEARNING_CRON,
    learning: {
      historyRuns: env.LEARNING_HISTORY_RUNS,
      minRuns: env.LEARNING_MIN_RUNS,
      minOccurrenceRatio: env.LEARNING_MIN_OCCURRENCE_RATIO,
      briefTopK: env.LEARNING_BRIEF_TOP_K,
      // redator = modelo barato de mensagem (mesma classe do redator do push).
      redactorModel: env.OPENROUTER_MESSAGE_MODEL,
      redactorMaxPerTick: env.LEARNING_REDACTOR_MAX_PER_TICK,
      phaseBufferDays: env.LEARNING_PHASE_BUFFER_DAYS,
      outcomeWindowDays: env.LEARNING_OUTCOME_WINDOW_DAYS,
      decayStaleDays: env.LEARNING_DECAY_STALE_DAYS,
      decayArchiveDays: env.LEARNING_DECAY_ARCHIVE_DAYS,
      accountMinEntities: env.LEARNING_ACCOUNT_MIN_ENTITIES,
      temporalLookbackDays: env.LEARNING_TEMPORAL_LOOKBACK_DAYS,
      opportunityMinMaterialMinor: env.LEARNING_OPPORTUNITY_MIN_MATERIAL_MINOR,
    },
    costCapUsd: env.LLM_COST_CAP_USD_PER_PERIOD,
    conversation: {
      model: env.CONVERSATION_MODEL,
      apiKey: env.OPENROUTER_API_KEY,
      baseUrl: env.OPENROUTER_BASE_URL,
      historyTurns: env.CONVERSATION_HISTORY_TURNS,
      maxTokens: env.CONVERSATION_MAX_TOKENS,
      debounceSeconds: env.CONVERSATION_DEBOUNCE_SECONDS,
      noticeThrottleSec: env.NOTICE_THROTTLE_SECONDS,
      turnTimeoutMs: env.CONVERSATION_TURN_TIMEOUT_MS,
      liveFetchTimeoutMs: env.CHAT_LIVE_FETCH_TIMEOUT_MS,
      httpTimeoutMs: env.CONVERSATION_HTTP_TIMEOUT_MS,
      maxRetries: env.LLM_MAX_RETRIES,
      fallbackModel: env.CONVERSATION_FALLBACK_MODEL,
      copyModel: env.COPY_MODEL,
      fetchGenerationCost: (id) => openRouterClient.getGenerationCost(id),
      groupIngestContext: env.TRAFEGO_GROUP_INGEST_CONTEXT,
      chatAdsWrites: env.TRAFEGO_CHAT_ADS_WRITES,
      groupContextRetentionDays: env.GROUP_CONTEXT_RETENTION_DAYS,
      groupContextMaxMessages: env.GROUP_CONTEXT_MAX_MESSAGES,
      groupContextWindowHours: env.GROUP_CONTEXT_WINDOW_HOURS,
      groupContextMaxTokens: env.GROUP_CONTEXT_MAX_TOKENS,
      focusTtlHours: env.CONVERSATION_FOCUS_TTL_HOURS,
      groupParticipantsCacheTtlSec: env.GROUP_PARTICIPANTS_CACHE_TTL_SEC,
    },
    transcription: {
      language: env.TRANSCRIPTION_LANGUAGE,
      maxAudioMb: env.TRANSCRIPTION_MAX_AUDIO_MB,
      provider: "openrouter", // adapter concreto = OpenRouter (composition nomeia o concreto)
      transcribingTtlSec,
    },
    // checkpointer LangGraph (Postgres): memória durável da conversa do WhatsApp
    // (Grafo B ReAct, thread por conversa). setup() cria as tabelas (idempotente).
    checkpointer,
  };
}

/** Lê e valida env do worker (schema zod em @trafego/config no boot — fail-fast). */
export function loadConfig(): CompositionConfig {
  const env = loadEnv();
  return {
    databaseUrl: env.DATABASE_URL,
    redisUrl: env.REDIS_URL,
  };
}
