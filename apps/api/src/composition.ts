import { createDb, type Database } from "@trafego/db";
import type {
  AdsPlatformPort,
  ApprovalPort,
  CredentialVaultPort,
  LLMProviderPort,
  MessagingChannelPort,
  MeteringPort,
  SchedulerPort,
} from "@trafego/shared/ports";

import { env } from "./env.js";
import { createAuthService } from "./modules/auth/service.js";
import { createDrizzleAuthRepo } from "./modules/auth/repo.js";
import { argon2Hasher } from "./modules/auth/password.js";
import { createOrgsService } from "./modules/orgs/service.js";
import { createDrizzleOrgsRepo } from "./modules/orgs/repo.js";
import { createAccountsService } from "./modules/accounts/service.js";
import { createDrizzleAccountsRepo } from "./modules/accounts/repo.js";
import { createConnectionsService } from "./modules/connections/service.js";
import { createDrizzleConnectionsRepo } from "./modules/connections/repo.js";
import { createChannelsService } from "./modules/channels/service.js";
import { createContactsService } from "./modules/contacts/service.js";
import { createAgentsService } from "./modules/agents/service.js";
import { createApprovalsService } from "./modules/approvals/service.js";
import { createRecommendationsService } from "./modules/recommendations/service.js";
import { createRunsService } from "./modules/runs/service.js";
import { createBillingService } from "./modules/billing/service.js";
import { createWebhooksService } from "./modules/webhooks/service.js";
import { Aes256CredentialVault } from "@trafego/credential-vault";
import { BullmqScheduler } from "@trafego/scheduler-bullmq";
import { MetaAdsAdapter, MetaGraphClient, MetaGovernor } from "@trafego/ads-meta";
import { EvolutionAdapter, EvolutionClient } from "@trafego/channel-evolution";
import { createPostgresApprovals } from "@trafego/approval-postgres";
import { createPostgresMetering } from "@trafego/metering-postgres";
import { Redis } from "ioredis";

// ─── Adapters de saída (portas) ──────────────────────────────────────────
// Adapters concretos vivem em pacotes próprios. Trocar provider/canal =
// trocar o import aqui, sem tocar em services/rotas.
//
// TODO: importar os adapters reais quando os pacotes existirem:
// import { MetaAdsAdapter } from "@trafego/ads-meta";
// import { EvolutionChannelAdapter } from "@trafego/channel-evolution";
// import { OpenRouterProvider } from "@trafego/llm-openrouter";

/** Portas instanciadas (borda de saída). */
export interface Adapters {
  readonly db: Database;
  readonly vault: CredentialVaultPort;
  readonly adsPlatform: AdsPlatformPort;
  readonly messaging: MessagingChannelPort;
  readonly llm: LLMProviderPort;
  readonly scheduler: SchedulerPort;
  readonly metering: MeteringPort;
  readonly approvals: ApprovalPort;
}

/** Serviços de cada slice (borda de aplicação). */
export interface Services {
  readonly auth: ReturnType<typeof createAuthService>;
  readonly orgs: ReturnType<typeof createOrgsService>;
  readonly accounts: ReturnType<typeof createAccountsService>;
  readonly connections: ReturnType<typeof createConnectionsService>;
  readonly channels: ReturnType<typeof createChannelsService>;
  readonly contacts: ReturnType<typeof createContactsService>;
  readonly agents: ReturnType<typeof createAgentsService>;
  readonly approvals: ReturnType<typeof createApprovalsService>;
  readonly recommendations: ReturnType<typeof createRecommendationsService>;
  readonly runs: ReturnType<typeof createRunsService>;
  readonly billing: ReturnType<typeof createBillingService>;
  readonly webhooks: ReturnType<typeof createWebhooksService>;
}

/** Container montado manualmente (sem DI). */
export interface Container {
  readonly adapters: Adapters;
  readonly services: Services;
  /** Cliente Redis compartilhado (scheduler + rate-limit da casca). */
  readonly redis: Redis;
}

/**
 * Placeholder tipado para portas cujo adapter ainda não foi plugado.
 * TODO: remover conforme cada adapter concreto for instanciado.
 */
function todoPort<T>(name: string): T {
  return new Proxy(
    {},
    {
      get() {
        throw new Error(`Port não plugada ainda: ${name} (composition root TODO)`);
      },
    },
  ) as T;
}

/**
 * Composition root manual: instancia adapters (portas) e injeta em cada
 * service; devolve o container que a casca HTTP monta nas rotas.
 */
export function buildContainer(): Container {
  const db = createDb(env.DATABASE_URL);

  // Portas plugadas na Fatia 0: vault (cripto do token) + scheduler (enfileira).
  const vault = new Aes256CredentialVault(env.CREDENTIAL_MASTER_KEY, env.CREDENTIAL_KEY_VERSION);
  const redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
  const scheduler = new BullmqScheduler(redis);

  // Meta plugada na Fatia 1b (onboarding: validar token + listar/derivar contas).
  // Token-only (sem app id/secret): a checagem de escopos + appsecret_proof é fast-follow.
  const adsPlatform: AdsPlatformPort = new MetaAdsAdapter({
    client: new MetaGraphClient(),
    governor: new MetaGovernor({ redis }),
  });

  // WhatsApp (Evolution) plugado na 3b: onboarding por QR + push proativo + código de opt-in.
  const messaging: MessagingChannelPort = new EvolutionAdapter({
    client: new EvolutionClient({ baseUrl: env.EVOLUTION_BASE_URL, apiKey: env.EVOLUTION_API_KEY }),
    apiOrigin: env.API_ORIGIN, // registra o webhook no connect (§9)
  });

  // Metering (3b): Postgres usage_events — o billing/usage lê daqui.
  const metering = createPostgresMetering(db);

  // Approvals (5b): Postgres — a API lista/resolve; o worker cria + aplica.
  const approvals = createPostgresApprovals(db);

  // Portas ainda não plugadas (fatias seguintes) — placeholders que lançam ao usar.
  const llm = todoPort<LLMProviderPort>("LLMProviderPort"); // worker roda o LLM; a API não

  const adapters: Adapters = {
    db,
    vault,
    adsPlatform,
    messaging,
    llm,
    scheduler,
    metering,
    approvals,
  };

  // Services — cada slice recebe só as portas de que precisa.
  // agents antes de runs: runs reusa `ensureAgent` (criação lazy) do slice de agentes.
  const agents = createAgentsService({ db, scheduler, approvals, revertTtlDays: env.REVERT_TTL_DAYS });
  const services: Services = {
    auth: createAuthService({ repo: createDrizzleAuthRepo(db), hasher: argon2Hasher }),
    orgs: createOrgsService({ repo: createDrizzleOrgsRepo(db) }),
    accounts: createAccountsService({ repo: createDrizzleAccountsRepo(db) }),
    connections: createConnectionsService({
      repo: createDrizzleConnectionsRepo(db),
      adsPlatform,
      vault,
    }),
    channels: createChannelsService({ db, messaging }),
    contacts: createContactsService({ db, messaging }),
    agents,
    approvals: createApprovalsService({ db, approvals, scheduler, revertTtlDays: env.REVERT_TTL_DAYS }),
    recommendations: createRecommendationsService({ db }),
    runs: createRunsService({
      db,
      scheduler,
      metering,
      ensureAgent: (orgId, accountId) => agents.getOrCreateForAccount(orgId, accountId),
      costCapUsd: env.LLM_COST_CAP_USD_PER_PERIOD,
    }),
    billing: createBillingService({ db, metering }),
    webhooks: createWebhooksService({ db, scheduler }),
  };

  return { adapters, services, redis };
}
