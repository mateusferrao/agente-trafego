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
import type { Logger } from "pino";

/**
 * Container de dependências resolvidas. Passado por injeção para grafos,
 * nós, executores e workers — nunca acessado via singleton global.
 */
export interface WorkerDeps {
  readonly db: Database;
  readonly logger: Logger;
  readonly ports: {
    readonly ads: AdsPlatformPort;
    readonly messaging: MessagingChannelPort;
    readonly llm: LLMProviderPort;
    readonly vault: CredentialVaultPort;
    readonly scheduler: SchedulerPort;
    readonly metering: MeteringPort;
    readonly approval: ApprovalPort;
  };
  /** Checkpointer do LangGraph (Postgres) — HITL durável via interrupt/resume. */
  readonly checkpointer: unknown; // TODO: tipar como BaseCheckpointSaver quando o adapter existir
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
export async function buildComposition(config: CompositionConfig): Promise<WorkerDeps> {
  // TODO: instanciar pino logger estruturado (redact do token — nunca logar plaintext).
  // TODO: criar Database via createDb(config.databaseUrl).
  // TODO: criar conexão ioredis (config.redisUrl) compartilhada por BullMQ + governor.
  // TODO: instanciar CredentialVaultPort (AES-256-GCM, CREDENTIAL_MASTER_KEY, keyVersion).
  // TODO: instanciar AdsPlatformPort = new MetaAdsAdapter(...) de @trafego/ads-meta
  //       (o governor/rate-limit por ad_account vive dentro desse adapter — ver src/governor).
  // TODO: instanciar MessagingChannelPort = new EvolutionChannelAdapter(...) de @trafego/channel-evolution.
  // TODO: instanciar LLMProviderPort = new OpenRouterProvider(...) de @trafego/llm-openrouter.
  // TODO: instanciar SchedulerPort (BullMQ), MeteringPort (Postgres), ApprovalPort (Postgres).
  // TODO: instanciar checkpointer = PostgresSaver.fromConnString(config.databaseUrl); await checkpointer.setup();
  throw new Error("not implemented: buildComposition");
}

/** Lê e valida env do worker (schema zod em @trafego/config no boot). */
export function loadConfig(): CompositionConfig {
  // TODO: validar process.env com schema zod (DATABASE_URL, REDIS_URL, ...).
  return {
    databaseUrl: process.env.DATABASE_URL ?? "",
    redisUrl: process.env.REDIS_URL ?? "",
  };
}
