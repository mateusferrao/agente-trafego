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
import { createChannelsService } from "./modules/channels/service.js";
import { createAgentsService } from "./modules/agents/service.js";
import { createApprovalsService } from "./modules/approvals/service.js";
import { createRunsService } from "./modules/runs/service.js";
import { createBillingService } from "./modules/billing/service.js";
import { createWebhooksService } from "./modules/webhooks/service.js";
import { createAdminService } from "./modules/admin/service.js";
import { Aes256CredentialVault } from "@trafego/credential-vault";
import { BullmqScheduler } from "@trafego/scheduler-bullmq";
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
  readonly channels: ReturnType<typeof createChannelsService>;
  readonly agents: ReturnType<typeof createAgentsService>;
  readonly approvals: ReturnType<typeof createApprovalsService>;
  readonly runs: ReturnType<typeof createRunsService>;
  readonly billing: ReturnType<typeof createBillingService>;
  readonly webhooks: ReturnType<typeof createWebhooksService>;
  readonly admin: ReturnType<typeof createAdminService>;
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

  // Portas ainda não plugadas (fatias seguintes) — placeholders que lançam ao usar.
  const adsPlatform = todoPort<AdsPlatformPort>("AdsPlatformPort"); // new MetaAdsAdapter()
  const messaging = todoPort<MessagingChannelPort>("MessagingChannelPort"); // new EvolutionChannelAdapter()
  const llm = todoPort<LLMProviderPort>("LLMProviderPort"); // new OpenRouterProvider({ apiKey: env.OPENROUTER_API_KEY })
  const metering = todoPort<MeteringPort>("MeteringPort"); // Postgres
  const approvals = todoPort<ApprovalPort>("ApprovalPort"); // Postgres

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
  const services: Services = {
    auth: createAuthService({ repo: createDrizzleAuthRepo(db), hasher: argon2Hasher }),
    orgs: createOrgsService({ repo: createDrizzleOrgsRepo(db) }),
    accounts: createAccountsService({ db, adsPlatform, vault }),
    channels: createChannelsService({ db, messaging }),
    agents: createAgentsService({ db }),
    approvals: createApprovalsService({ db, approvals }),
    runs: createRunsService({ db }),
    billing: createBillingService({ db, metering }),
    webhooks: createWebhooksService({ db, messaging, scheduler }),
    admin: createAdminService({ db, vault, scheduler }),
  };

  return { adapters, services, redis };
}
