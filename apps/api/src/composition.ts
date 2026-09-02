import { createDb, type Database } from "@trafego/db";
import type {
  AdsPlatformPort,
  ApprovalPort,
  CredentialVaultPort,
  LLMProviderPort,
  MailQueuePort,
  MessagingChannelPort,
  MeteringPort,
  SchedulerPort,
} from "@trafego/shared/ports";
import { buildMailJob } from "@trafego/shared";

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
import { createGroupsService } from "./modules/groups/service.js";
import { createContactsService } from "./modules/contacts/service.js";
import { createAgentsService } from "./modules/agents/service.js";
import { createApprovalsService } from "./modules/approvals/service.js";
import { createDraftsService } from "./modules/drafts/service.js";
import { createRecommendationsService } from "./modules/recommendations/service.js";
import { createLearningsService } from "./modules/learnings/service.js";
import { createRunsService, type OnboardingLogger } from "./modules/runs/service.js";
import { createDashboardService } from "./modules/dashboard/service.js";
import { createTimelineService } from "./modules/timeline/service.js";
import { createBillingService } from "./modules/billing/service.js";
import { createWebhooksService } from "./modules/webhooks/service.js";
import { Aes256CredentialVault } from "@trafego/credential-vault";
import { BullmqScheduler } from "@trafego/scheduler-bullmq";
import { MetaAdsAdapter, MetaBehaviorCatalogService, MetaGraphClient, MetaGovernor } from "@trafego/ads-meta";
import { EvolutionAdapter, EvolutionClient } from "@trafego/channel-evolution";
import { createPostgresApprovals } from "@trafego/approval-postgres";
import { createPostgresMetering } from "@trafego/metering-postgres";
import { createLocalStorage } from "@trafego/storage-local";
import { resolveDataDir } from "@trafego/config";
import { createS3Storage } from "@trafego/storage-s3";
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
  /** Enfileira email transacional (6b). A API só PRODUZ (não conhece o SDK do SES);
   *  o worker consome a fila `core.mail` e entrega. */
  readonly mailQueue: MailQueuePort;
}

/** Serviços de cada slice (borda de aplicação). */
export interface Services {
  readonly auth: ReturnType<typeof createAuthService>;
  readonly orgs: ReturnType<typeof createOrgsService>;
  readonly accounts: ReturnType<typeof createAccountsService>;
  readonly connections: ReturnType<typeof createConnectionsService>;
  readonly channels: ReturnType<typeof createChannelsService>;
  readonly groups: ReturnType<typeof createGroupsService>;
  readonly contacts: ReturnType<typeof createContactsService>;
  readonly agents: ReturnType<typeof createAgentsService>;
  readonly approvals: ReturnType<typeof createApprovalsService>;
  readonly drafts: ReturnType<typeof createDraftsService>;
  readonly recommendations: ReturnType<typeof createRecommendationsService>;
  readonly learnings: ReturnType<typeof createLearningsService>;
  readonly runs: ReturnType<typeof createRunsService>;
  readonly dashboard: ReturnType<typeof createDashboardService>;
  readonly timeline: ReturnType<typeof createTimelineService>;
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
export function buildContainer(logger?: OnboardingLogger): Container {
  const db = createDb(env.DATABASE_URL);

  // Portas plugadas na Fatia 0: vault (cripto do token) + scheduler (enfileira).
  const vault = new Aes256CredentialVault(env.CREDENTIAL_MASTER_KEY, env.CREDENTIAL_KEY_VERSION);
  const redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
  const scheduler = new BullmqScheduler(redis);

  // Meta plugada na Fatia 1b (onboarding: validar token + listar/derivar contas).
  // Token-only (sem app id/secret): a checagem de escopos + appsecret_proof é fast-follow.
  const adsMetaClient = new MetaGraphClient();
  const adsMetaGovernor = new MetaGovernor({ redis });
  const adsPlatform: AdsPlatformPort = new MetaAdsAdapter({
    client: adsMetaClient,
    governor: adsMetaGovernor,
    // catálogo de behaviors cacheado (a UI do site busca behaviors no editor de público).
    behaviorCatalog: new MetaBehaviorCatalogService(adsMetaClient, adsMetaGovernor, { redis, ttlSec: env.META_BEHAVIOR_CACHE_TTL_SEC }),
  });

  // WhatsApp (Evolution) plugado na 3b: onboarding por QR + push proativo + código de opt-in.
  const messaging: MessagingChannelPort = new EvolutionAdapter({
    client: new EvolutionClient({
      baseUrl: env.EVOLUTION_BASE_URL,
      apiKey: env.EVOLUTION_API_KEY,
      timeoutMs: env.EVOLUTION_HTTP_TIMEOUT_MS,
    }),
    apiOrigin: env.API_ORIGIN, // registra o webhook no connect (§9)
  });

  // Storage do blob de criativo (F7) — mesma porta do intake WhatsApp (worker). Driver por env:
  // local-fs (dev) ou s3-compat (prod). Trocar = só o env; core/casca/ingest intocados (§5).
  const storage =
    env.STORAGE_DRIVER === "s3"
      ? createS3Storage({
          region: env.STORAGE_REGION,
          bucket: env.STORAGE_BUCKET!, // garantido pelo refine (STORAGE_DRIVER=s3)
          accessKeyId: env.STORAGE_ACCESS_KEY!,
          secretAccessKey: env.STORAGE_SECRET_KEY!,
          forcePathStyle: env.STORAGE_FORCE_PATH_STYLE,
          ...(env.STORAGE_ENDPOINT ? { endpoint: env.STORAGE_ENDPOINT } : {}),
        })
      : createLocalStorage({ baseDir: resolveDataDir(env.CREATIVE_STORAGE_DIR), urlBase: env.CREATIVE_ASSET_URL_BASE });

  // Metering (3b): Postgres usage_events — o billing/usage lê daqui.
  const metering = createPostgresMetering(db);

  // Approvals (5b): Postgres — a API lista/resolve; o worker cria + aplica.
  const approvals = createPostgresApprovals(db);

  // Email (6b): a API só ENFILEIRA (produtor) via scheduler → fila `core.mail`.
  // O adapter de entrega (SES) vive só no worker; a API nunca importa o SDK.
  const mailQueue: MailQueuePort = { enqueue: (message) => scheduler.enqueue(buildMailJob(message)) };

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
    mailQueue,
  };

  // Services — cada slice recebe só as portas de que precisa.
  // agents antes de runs: runs reusa `ensureAgent` (criação lazy) do slice de agentes.
  const agents = createAgentsService({
    db,
    scheduler,
    approvals,
    revertTtlDays: env.REVERT_TTL_DAYS,
    qualityDefaults: {
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
  });
  // runs antes do literal: connections reusa `triggerOnboarding` (1ª análise + schedule no connect).
  const runs = createRunsService({
    db,
    scheduler,
    metering,
    ensureAgent: (orgId, accountId) => agents.getOrCreateForAccount(orgId, accountId),
    costCapUsd: env.LLM_COST_CAP_USD_PER_PERIOD,
    adsPlatform,
    vault,
    liveGapCheckTimeoutMs: env.RUNS_LIVE_GAP_CHECK_TIMEOUT_MS,
    ...(logger ? { logger } : {}),
  });
  const services: Services = {
    auth: createAuthService({
      repo: createDrizzleAuthRepo(db),
      hasher: argon2Hasher,
      mailQueue,
      email: {
        from: env.AUTH_EMAIL_FROM,
        appUrl: env.FRONTEND_URL,
        codeTtlMinutes: env.AUTH_EMAIL_TOKEN_TTL_MINUTES,
        resetTtlMinutes: env.AUTH_PASSWORD_RESET_TOKEN_TTL_MINUTES,
      },
    }),
    orgs: createOrgsService({ repo: createDrizzleOrgsRepo(db) }),
    accounts: createAccountsService({ repo: createDrizzleAccountsRepo(db) }),
    connections: createConnectionsService({
      repo: createDrizzleConnectionsRepo(db),
      adsPlatform,
      vault,
      ensureAgent: (orgId, accountId) => agents.getOrCreateForAccount(orgId, accountId),
      onboardAccount: (orgId, accountId, agentId) => runs.triggerOnboarding(orgId, accountId, agentId),
    }),
    channels: createChannelsService({ db, messaging }),
    groups: createGroupsService({ db, messaging }),
    contacts: createContactsService({ db, messaging }),
    agents,
    approvals: createApprovalsService({ db, approvals, scheduler, revertTtlDays: env.REVERT_TTL_DAYS }),
    drafts: createDraftsService({ db, adsPlatform, vault, approvals, storage, scheduler }),
    recommendations: createRecommendationsService({ db }),
    learnings: createLearningsService({
      db,
      scheduler,
      qualityDefaults: {
        minConversions: env.ANALYSIS_QUALITY_MIN_CONVERSIONS,
        minClicks: env.ANALYSIS_QUALITY_MIN_CLICKS,
        fatigueCtrDropPct: env.ANALYSIS_QUALITY_FATIGUE_CTR_DROP_PCT,
        fatigueFrequency: env.ANALYSIS_QUALITY_FATIGUE_FREQUENCY,
        zombieMinSpend: env.ANALYSIS_QUALITY_ZOMBIE_MIN_SPEND,
        marginalCpaWorsenPct: env.ANALYSIS_QUALITY_MARGINAL_CPA_WORSEN_PCT,
      },
      advisoryDismissCooldownDays: env.LEARNING_ADVISORY_DISMISS_COOLDOWN_DAYS,
    }),
    runs,
    dashboard: createDashboardService({
      db,
      scheduler,
      windowDays: env.ANALYSIS_WINDOW_DAYS,
      baselineDays: env.ANALYSIS_BASELINE_DAYS,
      freshThresholdMin: env.INSIGHTS_FRESH_THRESHOLD_MIN,
      now: () => new Date(),
    }),
    timeline: createTimelineService({ db }),
    billing: createBillingService({ db, metering, costCapUsd: env.LLM_COST_CAP_USD_PER_PERIOD }),
    webhooks: createWebhooksService({ db, scheduler }),
  };

  return { adapters, services, redis };
}
