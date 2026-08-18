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
  InsightsQuery,
  MutationResult,
} from "@trafego/shared/ports";
import { AdsPlatformError } from "@trafego/shared/ports";
import { META_TRANSIENT_CODES, MetaApiError, MetaGraphClient } from "./client.js";
import { MetaInsightsService } from "./insights.js";
import { MetaCreativesService } from "./creatives.js";
import { MetaMutationsService } from "./mutations.js";
import { MetaGovernor } from "./governor.js";
import { objectiveFromAdSet, objectiveFromCampaign, type RawPromotedObject } from "./meta-conversion-map.js";
import type { CustomConversionsResolver, CustomConversionInfo } from "./custom-conversions.js";

/** Prefixo obrigatório do ad account no path da Graph API. */
const AD_ACCOUNT_PREFIX = "act_";
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
    "id,name,status,effective_status,daily_budget,lifetime_budget,campaign_id,optimization_goal,promoted_object{pixel_id,custom_event_type,custom_conversion_id,page_id}",
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
}

interface MetaEntitiesPage {
  readonly data?: RawEntityNode[];
  readonly paging?: { readonly next?: string; readonly cursors?: { readonly after?: string } };
}

function mapStatus(effective?: string, raw?: string): EntityStatus {
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

function stripActPrefix(id: string): string {
  return id.startsWith(AD_ACCOUNT_PREFIX) ? id.slice(AD_ACCOUNT_PREFIX.length) : id;
}

function normalizeAdAccountId(id: string): string {
  return id.startsWith(AD_ACCOUNT_PREFIX) ? id : `${AD_ACCOUNT_PREFIX}${id}`;
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
    if (error.code === 190) return new AdsPlatformError("invalid_credential", error.message);
    if (error.httpStatus >= 500) return new AdsPlatformError("upstream", error.message);
    if (error.code !== undefined && META_TRANSIENT_CODES.has(error.code)) {
      return new AdsPlatformError("upstream", error.message);
    }
    return new AdsPlatformError("not_accessible", error.message);
  }
  return new AdsPlatformError("upstream", error instanceof Error ? error.message : "erro Meta desconhecido");
}

export interface MetaAdsAdapterDeps {
  readonly client: MetaGraphClient;
  readonly governor: MetaGovernor;
  readonly insights?: MetaInsightsService;
  readonly creatives?: MetaCreativesService;
  readonly mutations?: MetaMutationsService;
  /** Resolve nomes de conversão personalizada p/ rotular objetivos (opcional; degrada). */
  readonly customConversions?: CustomConversionsResolver;
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
  private readonly customConversions: CustomConversionsResolver | undefined;

  constructor(deps: MetaAdsAdapterDeps) {
    this.client = deps.client;
    this.governor = deps.governor;
    this.insights = deps.insights ?? new MetaInsightsService(deps.client, deps.governor);
    this.creatives = deps.creatives ?? new MetaCreativesService(deps.client);
    this.mutations = deps.mutations ?? new MetaMutationsService(deps.client);
    this.customConversions = deps.customConversions;
  }

  async listEntities(account: AdAccountRef, level: EntityLevel): Promise<AdEntity[]> {
    if (level === "account") return []; // conta não é um edge listável (metadados via getAdAccount)
    try {
      const accountId = normalizeAdAccountId(account.adAccountId);
      const nodes = await this.fetchEntities(accountId, level, account.accessToken);
      const resolved = await this.resolveCustomLabels(account, level, nodes);
      return nodes.map((node) => this.mapEntity(level, node, resolved));
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
    for (let page = 0; page < MAX_ENTITY_PAGES; page++) {
      const res = await this.client.request<MetaEntitiesPage>({
        method: "GET",
        path: `${accountId}/${ENTITY_EDGE[level]}`,
        accessToken,
        params: { fields: ENTITY_FIELDS[level], limit: ENTITY_PAGE_LIMIT, ...(after ? { after } : {}) },
      });
      out.push(...(res.data.data ?? []));
      after = res.data.paging?.next ? res.data.paging.cursors?.after : undefined;
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
    const dailyBudget = toMajorBudget(node.daily_budget);
    const lifetimeBudget = toMajorBudget(node.lifetime_budget);
    const objective = this.deriveObjective(level, node, resolved);
    return {
      id: node.id ?? "",
      level,
      name: node.name ?? node.id ?? "",
      status: mapStatus(node.effective_status, node.status),
      ...(parentId ? { parentId } : {}),
      ...(dailyBudget !== undefined ? { dailyBudget } : {}),
      ...(lifetimeBudget !== undefined ? { lifetimeBudget } : {}),
      ...(objective ? { objective } : {}),
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
    // TODO: governor.acquire → delega ao creatives service (image_url/thumbnail_url).
    return this.creatives.getCreatives(account, adIds);
  }

  async mutate(account: AdAccountRef, action: Action): Promise<MutationResult> {
    // TODO: governor.acquire → delega ao mutations service (idempotente, before/after).
    return this.mutations.mutate(account, action);
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
