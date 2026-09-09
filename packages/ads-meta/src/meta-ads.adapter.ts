import type {
  AccessibleAccount,
  AccountHealth,
  Action,
  ActivationTree,
  AdEntity,
  AdMetric,
  AudienceProfile,
  BidStrategy,
  CampaignStructure,
  Creative,
  CustomAudience,
  DeliveryEstimate,
  EntityLevel,
  EntityStatus,
  GeoSearchResult,
  InsightRow,
  InterestSearchResult,
  MetaAccountHealthStatus,
  WhatsappDestination,
  PageInfo,
} from "@trafego/shared/types";
import type {
  AdAccountRef,
  AdsPlatformPort,
  BreakdownInsightsQuery,
  DeliveryEstimateInput,
  DuplicateEntityInput,
  DuplicateResult,
  EntityBreakdownRow,
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
import { MetaWhatsappDestinationService } from "./whatsapp-destination.js";
import { MetaAudiencesService } from "./audiences.js";
import { MetaGeoSearchService } from "./geo-search.js";
import { MetaInterestSearchService } from "./interest-search.js";
import { MetaBehaviorCatalogService } from "./behavior-catalog.js";
import { MetaCampaignStructureService } from "./campaign-structure.js";
import { MetaGovernor } from "./governor.js";
import { MetaEntityCache } from "./entity-cache.js";
import { objectiveFromAdSet, objectiveFromCampaign, type RawPromotedObject } from "./meta-conversion-map.js";
import { audienceFromTargeting, type RawTargeting } from "./meta-audience-map.js";
import type { CustomConversionsResolver, CustomConversionInfo } from "./custom-conversions.js";

/** Campos de conta pedidos à Graph (id sem prefixo via `account_id`). */
const AD_ACCOUNT_FIELDS = "account_id,name,currency,business{id}";
/** Campos de SAÚDE da conta (status/saldo/gasto/pagamento) — chamada dedicada
 *  (`getAccountHealth`), separada de `AD_ACCOUNT_FIELDS` (onboarding, paginado). */
const ACCOUNT_HEALTH_FIELDS =
  "account_status,disable_reason,balance,amount_spent,spend_cap,funding_source_details{display_string,type}";
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
// `budget_remaining` (P1.2): a Meta já contabiliza o saldo restante do lifetime_budget — dá o
// sinal de teto de vitalício sem precisar de pacing por data nem de query de gasto all-time.
// bid_strategy/bid_amount (S2): a Meta expõe na campanha (CBO) OU no adset (ABO) — nunca
// os dois pra uma mesma decisão de lance; pedimos nos dois níveis e o mapper resolve o que veio.
const ENTITY_FIELDS: Readonly<Record<ListableLevel, string>> = {
  campaign: "id,name,status,effective_status,daily_budget,lifetime_budget,budget_remaining,objective,bid_strategy,bid_amount",
  adset:
    "id,name,status,effective_status,daily_budget,lifetime_budget,budget_remaining,campaign_id,optimization_goal,bid_strategy,bid_amount,promoted_object{pixel_id,custom_event_type,custom_conversion_id,page_id,whatsapp_phone_number},targeting{geo_locations,age_min,age_max,custom_audiences,excluded_custom_audiences,flexible_spec,interests}",
  ad: "id,name,status,effective_status,adset_id,campaign_id",
};

/** Tetos de página da leitura da árvore de ativação (single-page; paginação = fast-follow). */
const ACTIVATION_TREE_ADSET_LIMIT = 50;
const ACTIVATION_TREE_AD_LIMIT = 100;

/** effective_status/status (preferir effective) → EntityStatus do domínio. */
const STATUS_MAP: Readonly<Record<string, EntityStatus>> = {
  ACTIVE: "active",
  PAUSED: "paused",
  DELETED: "deleted",
  ARCHIVED: "archived",
  CAMPAIGN_PAUSED: "paused",
  ADSET_PAUSED: "paused",
};

/** `bid_strategy` cru da Meta → `BidStrategy` neutra (S2). Enum indocumentado/novo → undefined
 *  (honesto; nunca inventa um valor neutro pra algo que não reconhecemos). */
const BID_STRATEGY_MAP: Readonly<Record<string, BidStrategy>> = {
  LOWEST_COST_WITHOUT_CAP: "lowest_cost",
  LOWEST_COST_WITH_BID_CAP: "bid_cap",
  COST_CAP: "cost_cap",
  LOWEST_COST_WITH_MIN_ROAS: "min_roas",
};

/** `account_status` cru da Meta (inteiro) → `MetaAccountHealthStatus` neutro. Verificado
 *  ao vivo contra a doc oficial (achado da fatia de saúde de conta) — código não
 *  reconhecido (enum novo/indocumentado) → "unknown", nunca inventa. */
const ACCOUNT_STATUS_MAP: Readonly<Record<number, MetaAccountHealthStatus>> = {
  1: "active",
  2: "disabled",
  3: "unsettled",
  7: "pending_review",
  8: "pending_settlement",
  9: "grace_period",
  100: "pending_closure",
  101: "closed",
};

/** `funding_source_details.type` cru (inteiro) → `stored_balance` (pré-pago genuíno,
 *  saldo É o dado confiável) ou `other` (cartão/fatura/etc — saldo é valor
 *  acumulado-não-cobrado, não confiável como "saldo caindo"). Confirmado ao vivo na doc
 *  oficial da Meta: 20 = STORED_BALANCE; todo o resto tratado como "other". */
const FUNDING_TYPE_STORED_BALANCE = 20;

interface RawEntityNode {
  readonly id?: string;
  readonly name?: string;
  readonly status?: string;
  readonly effective_status?: string;
  readonly daily_budget?: string;
  readonly lifetime_budget?: string;
  readonly budget_remaining?: string;
  readonly campaign_id?: string;
  readonly adset_id?: string;
  readonly objective?: string;
  readonly optimization_goal?: string;
  readonly bid_strategy?: string;
  readonly bid_amount?: string;
  readonly promoted_object?: RawPromotedObject;
  readonly targeting?: RawTargeting;
}

interface MetaEntitiesPage {
  readonly data?: RawEntityNode[];
  readonly paging?: { readonly next?: string; readonly cursors?: { readonly after?: string } };
}

/** A página tem próxima (há mais entidades além do teto pedido)? — evita sub-ativar em silêncio. */
function hasNextPage(page: MetaEntitiesPage): boolean {
  return !!page.paging?.next;
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

interface MetaAccountHealthNode {
  readonly account_status?: number;
  readonly disable_reason?: number;
  readonly balance?: string;
  readonly amount_spent?: string;
  readonly spend_cap?: string;
  readonly funding_source_details?: { readonly display_string?: string; readonly type?: number };
}

/** `account_status` cru → neutro. Código não reconhecido → "unknown" (nunca inventa). */
function mapAccountStatus(raw?: number): MetaAccountHealthStatus {
  return (raw !== undefined && ACCOUNT_STATUS_MAP[raw]) || "unknown";
}

/** `disable_reason` cru → neutro. Só `0` (NONE) é confiavelmente conhecido; qualquer outro
 *  valor não-zero vira "unknown_reason" honesto (a Meta não documenta o enum completo). */
function mapDisableReason(raw?: number): string | undefined {
  if (raw === undefined || raw === 0) return undefined;
  return "unknown_reason";
}

/** `spend_cap: "0"` = SEM teto definido (achado ao vivo) — nunca vira "teto de R$ 0,00". */
function mapSpendCap(raw?: string): number | undefined {
  const major = toMajorBudget(raw);
  return major !== undefined && major > 0 ? major : undefined;
}

function mapAccountHealth(node: MetaAccountHealthNode): AccountHealth {
  const disableReason = mapDisableReason(node.disable_reason);
  const balanceMajor = toMajorBudget(node.balance);
  const amountSpentMajor = toMajorBudget(node.amount_spent);
  const spendCapMajor = mapSpendCap(node.spend_cap);
  const paymentMethodLabel = node.funding_source_details?.display_string;
  const rawFundingType = node.funding_source_details?.type;
  return {
    status: mapAccountStatus(node.account_status),
    ...(disableReason !== undefined ? { disableReason } : {}),
    ...(balanceMajor !== undefined ? { balanceMajor } : {}),
    ...(amountSpentMajor !== undefined ? { amountSpentMajor } : {}),
    ...(spendCapMajor !== undefined ? { spendCapMajor } : {}),
    ...(paymentMethodLabel ? { paymentMethodLabel } : {}),
    ...(rawFundingType !== undefined
      ? { fundingType: rawFundingType === FUNDING_TYPE_STORED_BALANCE ? ("stored_balance" as const) : ("other" as const) }
      : {}),
    checkedAt: new Date().toISOString(),
  };
}

/** Traduz o erro específico da Meta p/ o erro genérico da porta (casca desacoplada). */
function toAdsError(error: unknown): AdsPlatformError {
  if (error instanceof AdsPlatformError) return error; // já traduzido — não re-embrulha
  if (error instanceof MetaApiError) {
    // `error_user_msg` = texto legível que a Meta fez pro usuário final; repassa no port neutro
    // (a casca envelopa). Sem ele, cai no `error_user_title` (ex: "Ad set creation failed") — ainda
    // legível e melhor que silêncio → o desfecho determinístico (G2) tem o quê dizer. O `subcode`
    // NÃO sai daqui (fica interno ao adapter).
    const userMsg = error.userMessage ?? error.userTitle;
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
  /** Catálogo de comportamentos (behaviors) com cache Redis locale-scoped (opcional; ausente =
   *  busca fresco a cada chamada). */
  readonly behaviorCatalog?: MetaBehaviorCatalogService;
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
  private readonly whatsapp: MetaWhatsappDestinationService;
  private readonly audiences: MetaAudiencesService;
  private readonly geoSearch: MetaGeoSearchService;
  private readonly interestSearch: MetaInterestSearchService;
  private readonly behaviorCatalog: MetaBehaviorCatalogService;
  private readonly campaignStructure: MetaCampaignStructureService;
  private readonly customConversions: CustomConversionsResolver | undefined;
  private readonly entityCache: MetaEntityCache | undefined;

  constructor(deps: MetaAdsAdapterDeps) {
    this.client = deps.client;
    this.governor = deps.governor;
    this.insights = deps.insights ?? new MetaInsightsService(deps.client, deps.governor);
    this.creatives = deps.creatives ?? new MetaCreativesService(deps.client, deps.governor, deps.visionFrames);
    this.mutations = deps.mutations ?? new MetaMutationsService(deps.client);
    this.creation = deps.creation ?? new MetaCreationService(deps.client);
    this.whatsapp = new MetaWhatsappDestinationService(deps.client, deps.governor, this.creatives);
    this.audiences = new MetaAudiencesService(deps.client, deps.governor);
    this.geoSearch = new MetaGeoSearchService(deps.client, deps.governor);
    this.interestSearch = new MetaInterestSearchService(deps.client, deps.governor);
    this.behaviorCatalog = deps.behaviorCatalog ?? new MetaBehaviorCatalogService(deps.client, deps.governor);
    this.campaignStructure = new MetaCampaignStructureService(deps.client, deps.governor);
    this.customConversions = deps.customConversions;
    this.entityCache = deps.entityCache;
  }

  async listEntities(account: AdAccountRef, level: EntityLevel, opts?: { readonly statusFilter?: "active" }): Promise<AdEntity[]> {
    if (level === "account") return []; // conta não é um edge listável (metadados via getAdAccount)
    try {
      const accountId = normalizeAdAccountId(account.adAccountId);
      const statusFilter = opts?.statusFilter;
      // Filtrado NUNCA usa o cache do catálogo completo (chave conta+nível, sem dimensão de
      // filtro) — um resultado menor sob a mesma chave contaminaria o chat, que depende do
      // catálogo COMPLETO pra resolver nome→id de campanha pausada. Sem filtro → comportamento
      // de sempre (cache-first).
      if (!statusFilter) {
        const cached = await this.entityCache?.get(accountId, level);
        if (cached) return cached;
      }
      const nodes = await this.fetchEntities(accountId, level, account.accessToken, statusFilter);
      const resolved = await this.resolveCustomLabels(account, level, nodes);
      const entities = nodes.map((node) => this.mapEntity(level, node, resolved));
      if (!statusFilter) await this.entityCache?.set(accountId, level, entities);
      return entities;
    } catch (error) {
      throw toAdsError(error);
    }
  }

  private async fetchEntities(
    accountId: string,
    level: ListableLevel,
    accessToken: string,
    statusFilter?: "active",
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
            params: {
              fields: ENTITY_FIELDS[level],
              limit: ENTITY_PAGE_LIMIT,
              ...(after ? { after } : {}),
              // filtro NA ORIGEM (S7-sync) — corta a paginação em contas com muito histórico
              // pausado/arquivado; só quando o caller pede (o catálogo do chat nunca filtra).
              ...(statusFilter === "active" ? { effective_status: JSON.stringify(["ACTIVE"]) } : {}),
            },
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
    const budgetRemaining = toMajorBudget(node.budget_remaining);
    const bidStrategy = node.bid_strategy ? BID_STRATEGY_MAP[node.bid_strategy] : undefined;
    // cap só faz sentido junto de uma estratégia RECONHECIDA e ≠ lowest_cost (sem cap por
    // definição) — evita um bidCapMajor "solto" sem bidStrategy correspondente, ou
    // contraditório com lowest_cost, se a Meta um dia devolver bid_amount fora desse caso.
    const bidCapMajor = bidStrategy && bidStrategy !== "lowest_cost" ? toMajorBudget(node.bid_amount) : undefined;
    const objective = this.deriveObjective(level, node, resolved);
    // público + destino WhatsApp CTWA só existem no nível adset (targeting + promoted_object moram lá).
    const audience = level === "adset" ? audienceFromTargeting(node.targeting) : undefined;
    const waDigits = level === "adset" ? (node.promoted_object?.whatsapp_phone_number ?? "").replace(/\D+/g, "") : "";
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
      ...(budgetRemaining !== undefined ? { budgetRemaining } : {}),
      ...(bidStrategy ? { bidStrategy } : {}),
      ...(bidCapMajor !== undefined ? { bidCapMajor } : {}),
      ...(objective ? { objective } : {}),
      ...(audience ? { audience } : {}),
      ...(waDigits.length > 0 ? { whatsappNumber: waDigits } : {}),
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

  async getBreakdownInsights(query: BreakdownInsightsQuery): Promise<EntityBreakdownRow[]> {
    try {
      return await this.insights.getBreakdownInsights(query);
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

  async getAdMetrics(account: AdAccountRef, window: string): Promise<AdMetric[]> {
    return this.creation.getAdMetrics(account, window); // best-effort no service (falha → [])
  }

  async getVideoFrames(account: AdAccountRef, videoId: string): Promise<string[]> {
    try {
      return await this.creatives.videoFrames(account, videoId);
    } catch (error) {
      throw toAdsError(error);
    }
  }

  async getImageUrlByHash(account: AdAccountRef, imageHash: string): Promise<string | null> {
    try {
      return await this.creatives.imageUrlByHash(account, imageHash);
    } catch {
      return null; // best-effort: a miniatura nunca derruba o fluxo (o card cai no placeholder)
    }
  }

  async getWhatsappDestination(account: AdAccountRef, campaignId: string): Promise<WhatsappDestination> {
    try {
      return await this.whatsapp.resolve(account, campaignId);
    } catch (error) {
      throw toAdsError(error);
    }
  }

  async getPageWhatsappInfo(account: AdAccountRef, pageId: string): Promise<PageInfo> {
    // best-effort (o service já degrada a { pageId } em falha) — não mapeia erro pra não quebrar o
    // rascunho por um destino que é só informativo.
    return this.whatsapp.pageInfo(account, pageId);
  }

  async listPages(account: AdAccountRef): Promise<PageInfo[]> {
    return this.whatsapp.listAccountPages(account);
  }

  async listCustomAudiences(account: AdAccountRef): Promise<CustomAudience[]> {
    try {
      return await this.audiences.list(account);
    } catch (error) {
      throw toAdsError(error);
    }
  }

  async searchGeo(account: AdAccountRef, query: string, locationTypes: readonly ("country" | "region" | "city" | "neighborhood")[]): Promise<GeoSearchResult[]> {
    try {
      return await this.geoSearch.search(account, query, locationTypes);
    } catch (error) {
      throw toAdsError(error);
    }
  }

  async searchInterests(account: AdAccountRef, query: string): Promise<InterestSearchResult[]> {
    try {
      return await this.interestSearch.search(account, query);
    } catch (error) {
      throw toAdsError(error);
    }
  }

  async searchBehaviors(account: AdAccountRef, query: string): Promise<InterestSearchResult[]> {
    try {
      return await this.behaviorCatalog.search(account, query);
    } catch (error) {
      throw toAdsError(error);
    }
  }

  async getDeliveryEstimate(account: AdAccountRef, input: DeliveryEstimateInput): Promise<DeliveryEstimate> {
    try {
      return await this.creation.deliveryEstimate(account, input, this.governor);
    } catch (error) {
      throw toAdsError(error);
    }
  }

  async getDeliveryEstimateForAdSet(account: AdAccountRef, adsetId: string): Promise<DeliveryEstimate> {
    try {
      return await this.creation.deliveryEstimateForAdSet(account, adsetId, this.governor);
    } catch (error) {
      throw toAdsError(error);
    }
  }

  async readCampaignStructure(account: AdAccountRef, campaignId: string): Promise<CampaignStructure> {
    try {
      return await this.campaignStructure.read(account, campaignId, normalizeAdAccountId(account.adAccountId));
    } catch (error) {
      throw toAdsError(error);
    }
  }

  async readActivationTree(account: AdAccountRef, level: "campaign" | "adset", id: string): Promise<ActivationTree> {
    try {
      const accountId = normalizeAdAccountId(account.adAccountId);
      // `status` = próprio (o que RELIGAR), `effective_status` = efetivo (o que ENTREGA).
      const adsPage = await callWithGovernor(
        accountId,
        () =>
          this.client.request<MetaEntitiesPage>({
            method: "GET",
            path: `${id}/ads`,
            accessToken: account.accessToken,
            params: { fields: "id,name,status,effective_status,adset_id", limit: ACTIVATION_TREE_AD_LIMIT },
          }),
        { governor: this.governor },
      );
      const ads = (adsPage.data ?? [])
        .filter((a): a is RawEntityNode & { id: string } => !!a.id)
        .map((a) => ({ id: a.id, name: a.name ?? null, status: mapStatus(a.status), effectiveStatus: mapStatus(a.effective_status, a.status), adsetId: a.adset_id ?? "" }));
      // conjunto: os anúncios já são os descendentes (não há sub-conjunto). campanha: também os conjuntos.
      if (level === "adset") return { adsets: [], ads, truncated: hasNextPage(adsPage) };
      const adsetsPage = await callWithGovernor(
        accountId,
        () =>
          this.client.request<MetaEntitiesPage>({
            method: "GET",
            path: `${id}/adsets`,
            accessToken: account.accessToken,
            params: { fields: "id,name,status,effective_status", limit: ACTIVATION_TREE_ADSET_LIMIT },
          }),
        { governor: this.governor },
      );
      const adsets = (adsetsPage.data ?? [])
        .filter((a): a is RawEntityNode & { id: string } => !!a.id)
        .map((a) => ({ id: a.id, name: a.name ?? null, status: mapStatus(a.status), effectiveStatus: mapStatus(a.effective_status, a.status) }));
      return { adsets, ads, truncated: hasNextPage(adsPage) || hasNextPage(adsetsPage) };
    } catch (error) {
      throw toAdsError(error);
    }
  }

  async getAudienceProfile(account: AdAccountRef, adsetId: string): Promise<AudienceProfile | null> {
    try {
      return await this.creation.getAudienceProfile(account, adsetId);
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

  async getCampaignBudgetLayout(account: AdAccountRef, campaignId: string) {
    try {
      return await this.creation.getCampaignBudgetLayout(account, campaignId);
    } catch (error) {
      throw toAdsError(error);
    }
  }

  async createCampaign(account: AdAccountRef, input: Parameters<AdsPlatformPort["createCampaign"]>[1]) {
    return this.writeThroughGovernor(account, () => this.creation.createCampaign(account, input));
  }

  async deleteCampaign(account: AdAccountRef, campaignId: string): Promise<boolean> {
    return this.writeThroughGovernor(account, () => this.creation.deleteCampaign(account, campaignId));
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

  /** Lê o estado atual (status + budgets) de uma entidade — re-check fresco (drift). Passa pelo
   *  `callWithGovernor` (acquire + retry de rate-limit/transiente) — GET idempotente, seguro retriar. */
  async readEntityState(account: AdAccountRef, entityId: string): Promise<Record<string, unknown>> {
    try {
      return await callWithGovernor(
        normalizeAdAccountId(account.adAccountId),
        () => this.mutations.readEntityStateResponse(account, entityId),
        { governor: this.governor },
      );
    } catch (error) {
      throw toAdsError(error);
    }
  }

  /** Lê SÓ o `targeting` cru atual de um adset — drift fino do revert de `adjust_audience` (D4). */
  async readAdSetTargeting(account: AdAccountRef, adsetId: string): Promise<Record<string, unknown> | null> {
    try {
      const acquired = await this.governor.acquire(normalizeAdAccountId(account.adAccountId));
      if (!acquired.granted) throw cooldownError();
      return await this.mutations.readAdSetTargeting(account, adsetId);
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

  async getAccountHealth(account: AdAccountRef): Promise<AccountHealth> {
    try {
      const accountId = normalizeAdAccountId(account.adAccountId);
      const acquired = await this.governor.acquire(accountId);
      if (!acquired.granted) throw cooldownError();
      const res = await this.client.request<MetaAccountHealthNode>({
        method: "GET",
        path: accountId,
        accessToken: account.accessToken,
        params: { fields: ACCOUNT_HEALTH_FIELDS },
      });
      return mapAccountHealth(res.data);
    } catch (error) {
      throw toAdsError(error);
    }
  }
}
