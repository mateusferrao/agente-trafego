import type { Redis } from "ioredis";
import type { InterestSearchResult } from "@trafego/shared";
import type { AdAccountRef } from "@trafego/shared/ports";
import type { MetaGraphClient } from "./client.js";
import { callWithGovernor } from "./call-with-governor.js";
import type { MetaGovernor } from "./governor.js";
import { normalizeAdAccountId } from "./ids.js";

/**
 * Catálogo de COMPORTAMENTOS (behaviors) — `/search?type=adTargetingCategory&class=behaviors`.
 * Diferente de interesses (`adinterest`, busca por TEXTO no servidor), behaviors é uma **enumeração
 * completa SEM busca** (confirmado no spike: 285 itens pt_BR, `paging:false`, campos
 * `{id,name,path[],audience_size_lower_bound}`). Por isso: fetch da lista inteira + **cache Redis
 * locale-scoped** (a taxonomia varia por mercado, não por conta) + **filtro local** de candidatos.
 * O match determinístico nome→id fica no worker (`resolveNamedMatch`, igual aos interesses) — aqui
 * só narramos a lista pros candidatos relevantes. Vocabulário Meta isolado; devolve neutro.
 */
const BEHAVIOR_FETCH_LIMIT = 2000; // teto defensivo; a lista real (~285) vem sem paginação
const BEHAVIOR_CANDIDATES = 10;
const CACHE_PREFIX = "meta:behaviors";

interface RawTargetingCategory {
  readonly id?: string;
  readonly name?: string;
  readonly path?: readonly string[];
  readonly audience_size_lower_bound?: number;
}
interface RawBehaviorsResponse {
  readonly data?: readonly RawTargetingCategory[];
}

/** normaliza p/ match local tolerante (minúsculas, sem acento). */
function normalize(s: string): string {
  return [...s.toLowerCase().normalize("NFD")].filter((c) => { const cp = c.codePointAt(0) ?? 0; return cp < 0x300 || cp > 0x36f; }).join("").trim();
}

export interface BehaviorCatalogOptions {
  readonly redis?: Redis;
  /** validade do catálogo em segundos; ausente/<=0 = sem cache (busca fresco). */
  readonly ttlSec?: number;
  readonly locale?: string;
}

export class MetaBehaviorCatalogService {
  private readonly client: MetaGraphClient;
  private readonly governor: MetaGovernor;
  private readonly redis: Redis | undefined;
  private readonly ttlSec: number;
  private readonly locale: string;

  constructor(client: MetaGraphClient, governor: MetaGovernor, options?: BehaviorCatalogOptions) {
    this.client = client;
    this.governor = governor;
    this.redis = options?.redis;
    this.ttlSec = options?.ttlSec ?? 0;
    this.locale = options?.locale ?? "pt_BR";
  }

  /** Lista completa (cacheada locale-scoped). Cache off/miss → busca na Meta e re-cacheia. */
  async list(account: AdAccountRef): Promise<InterestSearchResult[]> {
    const cached = await this.readCache();
    if (cached) return cached;
    const accountId = normalizeAdAccountId(account.adAccountId);
    const data = await callWithGovernor(
      accountId,
      () =>
        this.client.request<RawBehaviorsResponse>({
          method: "GET",
          path: "search",
          accessToken: account.accessToken,
          params: { type: "adTargetingCategory", class: "behaviors", limit: BEHAVIOR_FETCH_LIMIT, locale: this.locale },
        }),
      { governor: this.governor },
    );
    const out: InterestSearchResult[] = [];
    for (const r of data.data ?? []) {
      if (!r.id || !r.name) continue;
      out.push({
        id: r.id,
        name: r.name,
        ...(typeof r.audience_size_lower_bound === "number" ? { audienceSize: r.audience_size_lower_bound } : {}),
        ...(r.path && r.path.length > 0 ? { path: r.path } : {}),
      });
    }
    await this.writeCache(out);
    return out;
  }

  /** Candidatos relevantes p/ um termo — filtro LOCAL (substring normalizado) sobre a lista. */
  async search(account: AdAccountRef, query: string): Promise<InterestSearchResult[]> {
    const q = normalize(query);
    if (!q) return [];
    const all = await this.list(account);
    return all.filter((b) => normalize(b.name).includes(q) || (b.path ?? []).some((p) => normalize(p).includes(q))).slice(0, BEHAVIOR_CANDIDATES);
  }

  private cacheKey(): string {
    return `${CACHE_PREFIX}:${this.locale}`;
  }

  private async readCache(): Promise<InterestSearchResult[] | null> {
    if (!this.redis || this.ttlSec <= 0) return null;
    const raw = await this.redis.get(this.cacheKey());
    if (!raw) return null;
    try {
      return JSON.parse(raw) as InterestSearchResult[];
    } catch {
      return null;
    }
  }

  private async writeCache(list: InterestSearchResult[]): Promise<void> {
    if (!this.redis || this.ttlSec <= 0 || list.length === 0) return;
    await this.redis.set(this.cacheKey(), JSON.stringify(list), "EX", this.ttlSec);
  }
}
