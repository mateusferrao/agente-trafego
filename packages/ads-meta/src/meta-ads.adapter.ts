import type {
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
import { MetaGraphClient } from "./client.js";
import { MetaInsightsService } from "./insights.js";
import { MetaCreativesService } from "./creatives.js";
import { MetaMutationsService } from "./mutations.js";
import { MetaGovernor } from "./governor.js";

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

  async listAccessibleAccounts(accessToken: string): Promise<{ id: string; name: string }[]> {
    // TODO: GET /me/adaccounts?fields=id,name,account_status (onboarding) → paginar.
    throw new Error("not implemented");
  }
}
