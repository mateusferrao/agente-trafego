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
} from "@trafego/shared/ports";
import type { Database } from "@trafego/db/client";
import { createDb } from "@trafego/db";
import { loadEnv } from "@trafego/config";
import { Aes256CredentialVault } from "@trafego/credential-vault";
import { BullmqScheduler } from "@trafego/scheduler-bullmq";
import { CustomConversionsResolver, MetaAdsAdapter, MetaEntityCache, MetaGraphClient, MetaGovernor } from "@trafego/ads-meta";
import { EvolutionAdapter, EvolutionClient } from "@trafego/channel-evolution";
import { OpenRouterAdapter, OpenRouterClient } from "@trafego/llm-openrouter";
import { createPostgresApprovals } from "@trafego/approval-postgres";
import { createPostgresMetering, withLlmMetering } from "@trafego/metering-postgres";
import { createMailer } from "@trafego/mailer";
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import type { BaseCheckpointSaver } from "@langchain/langgraph";
import { Redis } from "ioredis";
import { pino, type Logger } from "pino";
import { createDrizzleInsightsSnapshotsRepo } from "./modules/insights/repo.js";
import { createInsightsSyncService, type InsightsSyncService } from "./modules/insights/sync-service.js";

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
  };
  /** Sync de insights (2a): coleta a série temporal Meta → insights_snapshots. */
  readonly insightsSync: InsightsSyncService;
  /** Config da análise (3a/3b) — defaults globais de produto (env; override por-agente). */
  readonly analysis: import("./modules/analysis/config.js").AnalysisDefaults;
  /** Frescura (6a): limite de staleness (min) do sync-only + intervalo do sweep. */
  readonly insights: {
    readonly freshThresholdMin: number;
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
    /** Fallback de custo (bug do bindTools suprimindo usage.cost — ver nodes.ts). */
    readonly fetchGenerationCost: (generationId: string) => Promise<number | undefined>;
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
  const client = new MetaGraphClient();
  const ads = new MetaAdsAdapter({
    client,
    governor: new MetaGovernor({ redis }),
    customConversions: new CustomConversionsResolver({
      client,
      redis,
      ttlSec: env.CUSTOM_CONVERSIONS_CACHE_TTL_SEC,
    }),
    // cache do catálogo de entidades entre runs (corta o listEntities full = rate-limit).
    entityCache: new MetaEntityCache({ redis, ttlSec: env.META_ENTITY_CACHE_TTL_SEC }),
    visionFrames: env.ANALYSIS_VISION_FRAMES,
  });
  const insightsSync = createInsightsSyncService({
    ads,
    repo: createDrizzleInsightsSnapshotsRepo(db),
    refetchWindowDays: env.INSIGHTS_REFETCH_WINDOW_DAYS,
    retentionDays: env.INSIGHTS_RETENTION_DAYS,
  });
  const messaging = new EvolutionAdapter({
    client: new EvolutionClient({ baseUrl: env.EVOLUTION_BASE_URL, apiKey: env.EVOLUTION_API_KEY }),
  });
  const scheduler = new BullmqScheduler(redis);
  // Metering (3b): grava usage_events (custo real por chamada). O LLM é envolvido
  // pelo decorator de metering (cross-cutting num lugar só — §13; atribui por meta).
  const metering = createPostgresMetering(db);
  const openRouterClient = new OpenRouterClient({
    apiKey: env.OPENROUTER_API_KEY,
    baseUrl: env.OPENROUTER_BASE_URL,
    maxRetries: env.LLM_MAX_RETRIES,
    referer: env.WEB_ORIGIN,
    title: "AutoTraffic",
  });
  const llm = withLlmMetering(
    new OpenRouterAdapter({ client: openRouterClient }),
    { metering, provider: "openrouter", onError: (err) => logger.warn({ err }, "metering:falhou") },
  );

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
    },
    insightsSync,
    analysis: {
      model: env.OPENROUTER_MODEL,
      unitModel: env.OPENROUTER_UNIT_MODEL,
      messageModel: env.OPENROUTER_MESSAGE_MODEL,
      visionModel: env.OPENROUTER_VISION_MODEL,
      windowDays: env.ANALYSIS_WINDOW_DAYS,
      baselineDays: env.ANALYSIS_BASELINE_DAYS,
      topN: env.ANALYSIS_TOP_N,
      reviewEnabled: env.ANALYSIS_REVIEW_ENABLED,
      maxOutputTokens: env.ANALYSIS_MAX_OUTPUT_TOKENS,
      reasoningEffort: env.ANALYSIS_REASONING_EFFORT,
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
        fatigueCostRisePct: env.ANALYSIS_QUALITY_FATIGUE_COST_RISE_PCT,
        zombieMinSpend: env.ANALYSIS_QUALITY_ZOMBIE_MIN_SPEND,
      },
    },
    insights: {
      freshThresholdMin: env.INSIGHTS_FRESH_THRESHOLD_MIN,
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
    costCapUsd: env.LLM_COST_CAP_USD_PER_PERIOD,
    conversation: {
      model: env.CONVERSATION_MODEL,
      apiKey: env.OPENROUTER_API_KEY,
      baseUrl: env.OPENROUTER_BASE_URL,
      historyTurns: env.CONVERSATION_HISTORY_TURNS,
      maxTokens: env.CONVERSATION_MAX_TOKENS,
      debounceSeconds: env.CONVERSATION_DEBOUNCE_SECONDS,
      fetchGenerationCost: (id) => openRouterClient.getGenerationCost(id),
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
