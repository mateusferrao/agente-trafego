import type {
  AccessibleAccount,
  Action,
  AdEntity,
  Creative,
  EntityLevel,
  EntityStatus,
  InsightRow,
} from "@trafego/shared/types";
import type {
  AdAccountRef,
  AdsPlatformPort,
  DuplicateEntityInput,
  DuplicateResult,
  InsightsQuery,
  MutateOptions,
  MutationResult,
  RestoreResult,
} from "@trafego/shared/ports";
import { AdsPlatformError } from "@trafego/shared/ports";
import { META_RATE_LIMIT_CODES, META_TRANSIENT_CODES, MetaApiError, MetaGraphClient } from "./client.js";
import { callWithGovernor } from "./call-with-governor.js";
import { cooldownError } from "./rate-limit.js";
import { normalizeAdAccountId, stripActPrefix } from "./ids.js";
import { MetaInsightsService } from "./insights.js";
import { MetaCreativesService } from "./creatives.js";
import { MetaMutationsService } from "./mutations.js";
import { MetaCreationService } from "./creation.js";
import { MetaGovernor } from "./governor.js";
import { MetaEntityCache } from "./entity-cache.js";
import { objectiveFromAdSet, objectiveFromCampaign, type RawPromotedObject } from "./meta-conversion-map.js";
import { audienceFromTargeting, type RawTargeting } from "./meta-audience-map.js";
import type { CustomConversionsResolver, CustomConversionInfo } from "./custom-conversions.js";

/** Campos de conta pedidos à Graph (id sem prefixo via `account_id`). */
const AD_ACCOUNT_FIELDS = "account_id,name,currency,business{id}";
/** Página grande p/ minimizar round-trips no onboarding. */
const ACCOUNTS_PAGE_LIMIT = 200;
/** Trava de segurança contra loop de paginação. */
const MAX_ACCOUNT_PAGES = 50;
const ENTITY_PAGE_LIMIT = 200;
const MAX_ENTITY_PAGES = 50;
/** Budget vem em unidade mínima (centavos). ÷100 cobre moedas de 2 casas (BRL/USD);
 *  moedas sem decimais (currency_offset) = follow-up. */
const MINOR_UNIT_DIVISOR = 100;

type ListableLevel = Exclude<EntityLevel, "account">;

/** Edge da Graph por nível. */
const ENTITY_EDGE: Readonly<Record<ListableLevel, string>> = {
  campaign: "campaigns",
  adset: "adsets",
  ad: "ads",
};

/** Campos pedidos por nível (adset traz optimization_goal + promoted_object). */
const ENTITY_FIELDS: Readonly<Record<ListableLevel, string>> = {
  campaign: "id,name,status,effective_status,daily_budget,lifetime_budget,objective",
  adset:
    "id,name,status,effective_status,daily_budget,lifetime_budget,campaign_id,optimization_goal,promoted_object{pixel_id,custom_event_type,custom_conversion_id,page_id},targeting{geo_locations,age_min,age_max,custom_audiences,excluded_custom_audiences,flexible_spec,interests}",
  ad: "id,name,status,effective_status,adset_id,campaign_id",
};

/** effective_status/status (preferir effective) → EntityStatus do domínio. */
const STATUS_MAP: Readonly<Record<string, EntityStatus>> = {
  ACTIVE: "active",
  PAUSED: "paused",
  DELETED: "deleted",
  ARCHIVED: "archived",
  CAMPAIGN_PAUSED: "paused",
  ADSET_PAUSED: "paused",
};

interface RawEntityNode {
  readonly id?: string;
  readonly name?: string;
  readonly status?: string;
  readonly effective_status?: string;
  readonly daily_budget?: string;
  readonly lifetime_budget?: string;
  readonly campaign_id?: string;
  readonly adset_id?: string;
  readonly objective?: string;
  readonly optimization_goal?: string;
  readonly promoted_object?: RawPromotedObject;
  readonly targeting?: RawTargeting;
}

interface MetaEntitiesPage {
  readonly data?: RawEntityNode[];
  readonly paging?: { readonly next?: string; readonly cursors?: { readonly after?: string } };
}

/**
 * `effective_status`/`status` da Meta → `EntityStatus` neutro do domínio. Exportado
 * (não só interno) — o worker reusa p/ interpretar o resultado cru de `readEntityState`
 * (releitura pontual do no-op guardrail, 5b — evita duplicar o mapeamento).
 */
export function mapStatus(effective?: string, raw?: string): EntityStatus {
  return (effective && STATUS_MAP[effective]) || (raw && STATUS_MAP[raw]) || "paused";
}

function toMajorBudget(raw?: string): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n / MINOR_UNIT_DIVISOR : undefined;
}

function parentIdOf(level: ListableLevel, node: RawEntityNode): string | undefined {
  if (level === "adset") return node.campaign_id;
  if (level === "ad") return node.adset_id ?? node.campaign_id;
  return undefined;
}

/** Link direto p/ a campanha ancestral (ad e adset) — evita two-hop ao montar a árvore. */
function campaignIdOf(level: ListableLevel, node: RawEntityNode): string | undefined {
  if (level === "adset" || level === "ad") return node.campaign_id;
  return undefined;
}

/** Nó cru de ad account da Graph API. */
interface MetaAdAccountNode {
  readonly id?: string;
  readonly account_id?: string;
  readonly name?: string;
  readonly currency?: string;
  readonly business?: { readonly id?: string };
}

interface MetaAccountsPage {
  readonly data?: MetaAdAccountNode[];
  readonly paging?: { readonly next?: string; readonly cursors?: { readonly after?: string } };
}

function mapAccount(node: MetaAdAccountNode): AccessibleAccount {
  const id = node.account_id ?? (node.id ? stripActPrefix(node.id) : "");
  return {
    id,
    name: node.name ?? id,
    ...(node.currency ? { currency: node.currency } : {}),
    ...(node.business?.id ? { businessId: node.business.id } : {}),
  };
}

/** Traduz o erro específico da Meta p/ o erro genérico da porta (casca desacoplada). */
function toAdsError(error: unknown): AdsPlatformError {
  if (error instanceof AdsPlatformError) return error; // já traduzido — não re-embrulha
  if (error instanceof MetaApiError) {
    // `error_user_msg` = texto legível que a Meta fez pro usuário final; repassa no port neutro
    // (a casca envelopa). O `subcode` NÃO sai daqui — fica interno ao adapter.
    const userMsg = error.userMessage;
    if (error.code === 190) return new AdsPlatformError("invalid_credential", error.message, userMsg);
    // rate-limit (throttling) → recuperável esperando; mensagem própria na casca.
    if (error.code !== undefined && META_RATE_LIMIT_CODES.has(error.code)) {
      return new AdsPlatformError("rate_limited", error.message, userMsg);
    }
    if (error.httpStatus >= 500) return new AdsPlatformError("upstream", error.message, userMsg);
    if (error.code !== undefined && META_TRANSIENT_CODES.has(error.code)) {
      return new AdsPlatformError("upstream", error.message, userMsg);
    }
    return new AdsPlatformError("not_accessible", error.message, userMsg);
  }
  return new AdsPlatformError("upstream", error instanceof Error ? error.message : "erro Meta desconhecido");
}

export interface MetaAdsAdapterDeps {
  readonly client: MetaGraphClient;
  readonly governor: MetaGovernor;
  readonly insights?: MetaInsightsService;
  readonly creatives?: MetaCreativesService;
  readonly mutations?: MetaMutationsService;
  readonly creation?: MetaCreationService;
  /** Resolve nomes de conversão personalizada p/ rotular objetivos (opcional; degrada). */
  readonly customConversions?: CustomConversionsResolver;
  /** Cache do catálogo de entidades entre runs (opcional; ausente = sempre lista fresco). */
  readonly entityCache?: MetaEntityCache;
  /** Frames HD por criativo de vídeo p/ a visão (Fatia 6c; default do service). */
  readonly visionFrames?: number;
}

/**
 * Adapter Meta (Graph v26) da `AdsPlatformPort`.
 * Responsável por rate-limit/governor, async report jobs e batch (§5/§7).
 * Amanhã Google/TikTok = novo adapter, zero mudança no core.
 */
export class MetaAdsAdapter implements AdsPlatformPort {
  private readonly client: MetaGraphClient;
  private readonly governor: MetaGovernor;
  private readonly insights: MetaInsightsService;
  private readonly creatives: MetaCreativesService;
  private readonly mutations: MetaMutationsService;
  private readonly creation: MetaCreationService;
  private readonly customConversions: CustomConversionsResolver | undefined;
  private readonly entityCache: MetaEntityCache | undefined;

  constructor(deps: MetaAdsAdapterDeps) {
    this.client = deps.client;
    this.governor = deps.governor;
    this.insights = deps.insights ?? new MetaInsightsService(deps.client, deps.governor);
    this.creatives = deps.creatives ?? new MetaCreativesService(deps.client, deps.governor, deps.visionFrames);
    this.mutations = deps.mutations ?? new MetaMutationsService(deps.client);
    this.creation = deps.creation ?? new MetaCreationService(deps.client);
    this.customConversions = deps.customConversions;
    this.entityCache = deps.entityCache;
  }

  async listEntities(account: AdAccountRef, level: EntityLevel): Promise<AdEntity[]> {
    if (level === "account") return []; // conta não é um edge listável (metadados via getAdAccount)
    try {
      const accountId = normalizeAdAccountId(account.adAccountId);
      // reusa o catálogo entre runs (a maior fonte de rate-limit); miss → lista fresco.
      const cached = await this.entityCache?.get(accountId, level);
      if (cached) return cached;
      const nodes = await this.fetchEntities(accountId, level, account.accessToken);
      const resolved = await this.resolveCustomLabels(account, level, nodes);
      const entities = nodes.map((node) => this.mapEntity(level, node, resolved));
      await this.entityCache?.set(accountId, level, entities);
      return entities;
    } catch (error) {
      throw toAdsError(error);
    }
  }

  private async fetchEntities(
    accountId: string,
    level: ListableLevel,
    accessToken: string,
  ): Promise<RawEntityNode[]> {
    const out: RawEntityNode[] = [];
    let after: string | undefined;
    // Cada página passa pelo governor. Se um cooldown pintar no meio da paginação, o
    // throw sobe e ESTE nível vira parcial (o worker marca `partial`) — as páginas já
    // buscadas são descartadas de propósito: uma lista truncada silenciosa enganaria a
    // análise ("essas são todas as campanhas"); parcial honesto > verdade pela metade.
    for (let page = 0; page < MAX_ENTITY_PAGES; page++) {
      const data = await callWithGovernor<MetaEntitiesPage>(
        accountId,
        () =>
          this.client.request<MetaEntitiesPage>({
            method: "GET",
            path: `${accountId}/${ENTITY_EDGE[level]}`,
            accessToken,
            params: { fields: ENTITY_FIELDS[level], limit: ENTITY_PAGE_LIMIT, ...(after ? { after } : {}) },
          }),
        { governor: this.governor },
      );
      out.push(...(data.data ?? []));
      after = data.paging?.next ? data.paging.cursors?.after : undefined;
      if (!after) break;
    }
    return out;
  }

  /** Resolve nomes das conversões personalizadas usadas pelos adsets (se houver resolver). */
  private async resolveCustomLabels(
    account: AdAccountRef,
    level: ListableLevel,
    nodes: readonly RawEntityNode[],
  ): Promise<ReadonlyMap<string, CustomConversionInfo>> {
    if (level !== "adset" || !this.customConversions) return new Map();
    const ids = new Set<string>();
    for (const n of nodes) {
      const cc = n.promoted_object?.custom_conversion_id;
      if (cc) ids.add(cc);
    }
    if (ids.size === 0) return new Map();
    return this.customConversions.resolveMany(account.adAccountId, account.accessToken, ids);
  }

  private mapEntity(
    level: ListableLevel,
    node: RawEntityNode,
    resolved: ReadonlyMap<string, CustomConversionInfo>,
  ): AdEntity {
    const parentId = parentIdOf(level, node);
    const campaignId = campaignIdOf(level, node);
    const adsetId = level === "ad" ? node.adset_id : undefined;
    const dailyBudget = toMajorBudget(node.daily_budget);
    const lifetimeBudget = toMajorBudget(node.lifetime_budget);
    const objective = this.deriveObjective(level, node, resolved);
    // público só existe no nível adset (o targeting mora lá).
    const audience = level === "adset" ? audienceFromTargeting(node.targeting) : undefined;
    return {
      id: node.id ?? "",
      level,
      name: node.name ?? node.id ?? "",
      status: mapStatus(node.effective_status, node.status),
      ...(parentId ? { parentId } : {}),
      ...(campaignId ? { campaignId } : {}),
      ...(adsetId ? { adsetId } : {}),
      ...(dailyBudget !== undefined ? { dailyBudget } : {}),
      ...(lifetimeBudget !== undefined ? { lifetimeBudget } : {}),
      ...(objective ? { objective } : {}),
      ...(audience ? { audience } : {}),
    };
  }

  private deriveObjective(
    level: ListableLevel,
    node: RawEntityNode,
    resolved: ReadonlyMap<string, CustomConversionInfo>,
  ): AdEntity["objective"] {
    if (level === "campaign") return objectiveFromCampaign(node.objective);
    if (level === "ad") return undefined; // herda do adset (join no assemble do brief)
    const obj = objectiveFromAdSet({
      ...(node.optimization_goal ? { optimizationGoal: node.optimization_goal } : {}),
      ...(node.promoted_object ? { promotedObject: node.promoted_object } : {}),
    });
    if (obj?.customConversionId) {
      const info = resolved.get(obj.customConversionId);
      if (info) return { ...obj, label: info.name };
    }
    return obj;
  }

  async getInsights(query: InsightsQuery): Promise<InsightRow[]> {
    try {
      return await this.insights.getInsights(query);
    } catch (error) {
      throw toAdsError(error);
    }
  }

  async getCreatives(account: AdAccountRef, adIds: readonly string[]): Promise<Creative[]> {
    try {
      return await this.creatives.getCreatives(account, adIds);
    } catch (error) {
      throw toAdsError(error);
    }
  }

  async getVideoFrames(account: AdAccountRef, videoId: string): Promise<string[]> {
    try {
      return await this.creatives.videoFrames(account, videoId);
    } catch (error) {
      throw toAdsError(error);
    }
  }

  async getAdSetCampaignBudget(account: AdAccountRef, adsetId: string): Promise<{ campaignId: string; dailyBudgetMinor: number; lifetimeBudgetMinor: number } | null> {
    try {
      return await this.creation.getAdSetCampaignBudget(account, adsetId);
    } catch (error) {
      throw toAdsError(error);
    }
  }

  async mutate(account: AdAccountRef, action: Action, opts?: MutateOptions): Promise<MutationResult> {
    try {
      // gate de cooldown nos writes (parcial-rápido): cooldown ativo → não escreve.
      const accountId = normalizeAdAccountId(account.adAccountId);
      const acquired = await this.governor.acquire(accountId);
      if (!acquired.granted) throw cooldownError();
      const result = await this.mutations.mutate(account, action, opts);
      // escrita REAL mudou o estado → catálogo cacheado ficou stale (dry-run não muda nada).
      if (!opts?.dryRun) await this.entityCache?.invalidate(accountId);
      return result;
    } catch (error) {
      throw toAdsError(error);
    }
  }

  async duplicateEntity(account: AdAccountRef, input: DuplicateEntityInput): Promise<DuplicateResult> {
    try {
      // gate de cooldown de write (mesma rede do mutate); cria entidades novas → catálogo stale.
      const accountId = normalizeAdAccountId(account.adAccountId);
      const acquired = await this.governor.acquire(accountId);
      if (!acquired.granted) throw cooldownError();
      const result = await this.creation.duplicateEntity(account, input);
      await this.entityCache?.invalidate(accountId);
      return result;
    } catch (error) {
      throw toAdsError(error);
    }
  }

  async setEntityBudget(account: AdAccountRef, entityId: string, dailyBudgetMinor: number) {
    return this.writeThroughGovernor(account, () => this.creation.setEntityBudget(account, entityId, dailyBudgetMinor));
  }

  async createCampaign(account: AdAccountRef, input: Parameters<AdsPlatformPort["createCampaign"]>[1]) {
    return this.writeThroughGovernor(account, () => this.creation.createCampaign(account, input));
  }

  async createAdSet(account: AdAccountRef, input: Parameters<AdsPlatformPort["createAdSet"]>[1]) {
    return this.writeThroughGovernor(account, () => this.creation.createAdSet(account, input));
  }

  async createAdCreative(account: AdAccountRef, input: Parameters<AdsPlatformPort["createAdCreative"]>[1]) {
    return this.writeThroughGovernor(account, () => this.creation.createAdCreative(account, input));
  }

  async createAd(account: AdAccountRef, input: Parameters<AdsPlatformPort["createAd"]>[1]) {
    return this.writeThroughGovernor(account, () => this.creation.createAd(account, input));
  }

  async inferCreationDefaults(account: AdAccountRef) {
    try {
      return await this.creation.inferCreationDefaults(account);
    } catch (error) {
      throw toAdsError(error);
    }
  }

  async uploadImage(account: AdAccountRef, input: Parameters<AdsPlatformPort["uploadImage"]>[1]) {
    return this.writeThroughGovernor(account, () => this.creation.uploadImage(account, input));
  }

  async uploadVideo(account: AdAccountRef, input: Parameters<AdsPlatformPort["uploadVideo"]>[1]) {
    return this.writeThroughGovernor(account, () => this.creation.uploadVideo(account, input));
  }

  async getVideoStatus(account: AdAccountRef, videoId: string) {
    try {
      return await this.creation.getVideoStatus(account, videoId);
    } catch (error) {
      throw toAdsError(error);
    }
  }

  /** Gate de cooldown de write + invalidação do catálogo, comum às criações. */
  private async writeThroughGovernor<T>(account: AdAccountRef, fn: () => Promise<T>): Promise<T> {
    try {
      const accountId = normalizeAdAccountId(account.adAccountId);
      const acquired = await this.governor.acquire(accountId);
      if (!acquired.granted) throw cooldownError();
      const result = await fn();
      await this.entityCache?.invalidate(accountId);
      return result;
    } catch (error) {
      throw toAdsError(error);
    }
  }

  async restoreEntityState(
    account: AdAccountRef,
    entityId: string,
    before: Readonly<Record<string, unknown>>,
  ): Promise<RestoreResult> {
    try {
      const accountId = normalizeAdAccountId(account.adAccountId);
      const acquired = await this.governor.acquire(accountId);
      if (!acquired.granted) throw cooldownError();
      const result = await this.mutations.restoreEntityState(account, entityId, before);
      await this.entityCache?.invalidate(accountId); // undo mudou o estado → catálogo stale
      return result;
    } catch (error) {
      throw toAdsError(error);
    }
  }

  /** Lê o estado atual (status + budgets) de uma entidade — re-check fresco (drift). */
  async readEntityState(account: AdAccountRef, entityId: string): Promise<Record<string, unknown>> {
    try {
      const acquired = await this.governor.acquire(normalizeAdAccountId(account.adAccountId));
      if (!acquired.granted) throw cooldownError();
      return await this.mutations.readEntityState(account, entityId);
    } catch (error) {
      throw toAdsError(error);
    }
  }

  async listAccessibleAccounts(accessToken: string): Promise<AccessibleAccount[]> {
    try {
      const out: AccessibleAccount[] = [];
      let after: string | undefined;
      for (let page = 0; page < MAX_ACCOUNT_PAGES; page++) {
        const res = await this.client.request<MetaAccountsPage>({
          method: "GET",
          path: "me/adaccounts",
          accessToken,
          params: { fields: AD_ACCOUNT_FIELDS, limit: ACCOUNTS_PAGE_LIMIT, ...(after ? { after } : {}) },
        });
        for (const node of res.data.data ?? []) out.push(mapAccount(node));
        after = res.data.paging?.next ? res.data.paging.cursors?.after : undefined;
        if (!after) break;
      }
      return out;
    } catch (error) {
      throw toAdsError(error);
    }
  }

  async getAdAccount(accessToken: string, adAccountId: string): Promise<AccessibleAccount> {
    try {
      const res = await this.client.request<MetaAdAccountNode>({
        method: "GET",
        path: normalizeAdAccountId(adAccountId),
        accessToken,
        params: { fields: AD_ACCOUNT_FIELDS },
      });
      return mapAccount(res.data);
    } catch (error) {
      throw toAdsError(error);
    }
  }
}
