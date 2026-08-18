import type {
  AccessibleAccount,
  Action,
  AdEntity,
  Creative,
  EntityLevel,
  InsightRow,
} from "@trafego/shared/types";
import type {
  AdAccountRef,
  AdsPlatformPort,
  InsightsQuery,
  MutationResult,
} from "@trafego/shared/ports";
import { AdsPlatformError } from "@trafego/shared/ports";
import { MetaApiError, MetaGraphClient } from "./client.js";
import { MetaInsightsService } from "./insights.js";
import { MetaCreativesService } from "./creatives.js";
import { MetaMutationsService } from "./mutations.js";
import { MetaGovernor } from "./governor.js";

/** Prefixo obrigatório do ad account no path da Graph API. */
const AD_ACCOUNT_PREFIX = "act_";
/** Campos de conta pedidos à Graph (id sem prefixo via `account_id`). */
const AD_ACCOUNT_FIELDS = "account_id,name,currency,business{id}";
/** Página grande p/ minimizar round-trips no onboarding. */
const ACCOUNTS_PAGE_LIMIT = 200;
/** Trava de segurança contra loop de paginação. */
const MAX_ACCOUNT_PAGES = 50;

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

/**
 * Codes de rate-limit/transiente da Meta que chegam como HTTP 4xx mas são
 * retryáveis (não são "conta inacessível"): app/user/BUC throttling + "please
 * retry". Mapeados p/ `upstream` (a porta sinaliza "tente de novo").
 */
const META_TRANSIENT_CODES = new Set([1, 2, 4, 17, 32, 613, 80000, 80001, 80002, 80003, 80004]);

/** Traduz o erro específico da Meta p/ o erro genérico da porta (casca desacoplada). */
function toAdsError(error: unknown): AdsPlatformError {
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

  constructor(deps: MetaAdsAdapterDeps) {
    this.client = deps.client;
    this.governor = deps.governor;
    this.insights = deps.insights ?? new MetaInsightsService(deps.client);
    this.creatives = deps.creatives ?? new MetaCreativesService(deps.client);
    this.mutations = deps.mutations ?? new MetaMutationsService(deps.client);
  }

  async listEntities(account: AdAccountRef, level: EntityLevel): Promise<AdEntity[]> {
    // TODO: governor.acquire → GET act_{id}/{campaigns|adsets|ads} (batched) → mapear AdEntity.
    throw new Error("not implemented");
  }

  async getInsights(query: InsightsQuery): Promise<InsightRow[]> {
    // TODO: governor.acquire → delega ao async report job service; degradação graciosa.
    return this.insights.getInsights(query);
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
