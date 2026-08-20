// Composition root MANUAL do worker (sem DI container), espelhando apps/api.
// Instancia adapters concretos, resolve ports e injeta db/logger. Nada aqui é
// importado pelo core (`@trafego/core` só conhece interfaces de `@trafego/shared`).

import type {
  AdsPlatformPort,
  ApprovalPort,
  CredentialVaultPort,
  LLMProviderPort,
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
  };
  /** Sync de insights (2a): coleta a série temporal Meta → insights_snapshots. */
  readonly insightsSync: InsightsSyncService;
  /** Config da análise (3a/3b) — defaults globais de produto (env; override por-agente). */
  readonly analysis: import("./modules/analysis/config.js").AnalysisDefaults;
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
  /** Checkpointer do LangGraph (Postgres) — HITL durável (5b). undefined na 3a (read-only). */
  readonly checkpointer: unknown;
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
  const llm = withLlmMetering(
    new OpenRouterAdapter({
      client: new OpenRouterClient({
        apiKey: env.OPENROUTER_API_KEY,
        baseUrl: env.OPENROUTER_BASE_URL,
        maxRetries: env.LLM_MAX_RETRIES,
        referer: env.WEB_ORIGIN,
        title: "AutoTraffic",
      }),
    }),
    { metering, provider: "openrouter", onError: (err) => logger.warn({ err }, "metering:falhou") },
  );

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
    // checkpointer LangGraph = 5b (HITL durável). 3a é read-only linear → sem checkpointer.
    checkpointer: undefined,
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
