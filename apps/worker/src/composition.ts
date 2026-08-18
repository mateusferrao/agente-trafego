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
import { CustomConversionsResolver, MetaAdsAdapter, MetaGraphClient, MetaGovernor } from "@trafego/ads-meta";
import { EvolutionAdapter, EvolutionClient } from "@trafego/channel-evolution";
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
  /** Checkpointer do LangGraph (Postgres) — HITL durável via interrupt/resume. */
  readonly checkpointer: unknown; // TODO: tipar como BaseCheckpointSaver quando o adapter existir
  /** Scaffolding da Fatia 0: instância + destinatário fixos do WhatsApp. */
  readonly fatia0: {
    readonly evolutionInstance: string;
    readonly recipientPhone: string;
  };
}

/** Placeholder tipado p/ portas ainda não plugadas (lançam ao usar). */
function todoPort<T>(name: string): T {
  return new Proxy(
    {},
    {
      get() {
        throw new Error(`Port não plugada ainda: ${name} (worker composition TODO)`);
      },
    },
  ) as T;
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

  return {
    db,
    logger,
    redis,
    ports: {
      ads,
      messaging,
      vault,
      scheduler,
      // ainda não plugadas na Fatia 0 (LLM=3a, metering/approval=fatias seguintes).
      llm: todoPort<WorkerDeps["ports"]["llm"]>("LLMProviderPort"),
      metering: todoPort<WorkerDeps["ports"]["metering"]>("MeteringPort"),
      approval: todoPort<WorkerDeps["ports"]["approval"]>("ApprovalPort"),
    },
    insightsSync,
    // checkpointer LangGraph = fatia 3a (grafo real). Handler mínimo não usa grafo.
    checkpointer: undefined,
    fatia0: {
      evolutionInstance: env.EVOLUTION_INSTANCE,
      recipientPhone: env.FATIA0_RECIPIENT_PHONE,
    },
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
