import type { Redis } from "ioredis";
import type { ConversionGoal } from "@trafego/shared";
import type { MetaGraphClient } from "./client.js";
import { goalFromCustomEventType } from "./meta-conversion-map.js";

/**
 * Resolve id de conversão personalizada (`offsite_conversion.custom.<id>`) → nome +
 * goal, para ROTULAR o objetivo da entidade (a MATH do CPA usa só o id, então nunca
 * depende disto). Cacheia a lista da conta no Redis (já existe) com TTL; um id fora
 * do mapa cacheado (conversão criada depois) dispara **um** refresh.
 */

const CACHE_KEY_PREFIX = "meta:customconv";
const AD_ACCOUNT_PREFIX = "act_";
const PAGE_LIMIT = 200;
const MAX_PAGES = 25;
const FIELDS = "id,name,custom_event_type";

export interface CustomConversionInfo {
  readonly name: string;
  readonly goal: ConversionGoal;
}

interface RawCustomConversion {
  readonly id?: string;
  readonly name?: string;
  readonly custom_event_type?: string;
}

interface CustomConversionsPage {
  readonly data?: RawCustomConversion[];
  readonly paging?: { readonly next?: string; readonly cursors?: { readonly after?: string } };
}

export interface CustomConversionsResolverOptions {
  readonly client: MetaGraphClient;
  readonly redis: Redis;
  readonly ttlSec: number;
}

export class CustomConversionsResolver {
  constructor(private readonly opts: CustomConversionsResolverOptions) {}

  /**
   * Resolve os `ids` pedidos: lê o cache (Redis); cache-miss → busca. Se algum id
   * ainda faltar (conversão nova desde o cache) → **1 refresh**. Ids ainda ausentes
   * ficam de fora (o chamador degrada p/ id/label). Falha da API → mapa parcial/vazio.
   */
  async resolveMany(
    adAccountId: string,
    accessToken: string,
    ids: ReadonlySet<string>,
  ): Promise<ReadonlyMap<string, CustomConversionInfo>> {
    let map = await this.readCache(adAccountId);
    let fetchedFresh = false;
    if (!map) {
      map = await this.fetchAndCache(adAccountId, accessToken);
      fetchedFresh = true;
    }
    // lookup-miss (id novo desde o cache) → 1 refresh — mas só se o mapa veio do
    // CACHE. Se já buscamos fresco agora, um id ausente é inacessível/deletado:
    // re-buscar seria idêntico e martelaria a API (rate-limited) a cada chamada.
    if (!fetchedFresh && ids.size > 0 && [...ids].some((id) => !map!.has(id))) {
      map = await this.fetchAndCache(adAccountId, accessToken);
    }
    return map;
  }

  private cacheKey(adAccountId: string): string {
    return `${CACHE_KEY_PREFIX}:${adAccountId}`;
  }

  private async readCache(adAccountId: string): Promise<Map<string, CustomConversionInfo> | null> {
    const raw = await this.opts.redis.get(this.cacheKey(adAccountId));
    if (!raw) return null;
    try {
      const obj = JSON.parse(raw) as Record<string, CustomConversionInfo>;
      return new Map(Object.entries(obj));
    } catch {
      return null;
    }
  }

  private async fetchAndCache(
    adAccountId: string,
    accessToken: string,
  ): Promise<Map<string, CustomConversionInfo>> {
    const map = new Map<string, CustomConversionInfo>();
    try {
      for (const r of await this.fetchAll(adAccountId, accessToken)) {
        if (!r.id) continue;
        map.set(r.id, { name: r.name ?? r.id, goal: goalFromCustomEventType(r.custom_event_type) });
      }
      const obj = Object.fromEntries(map);
      await this.opts.redis.set(this.cacheKey(adAccountId), JSON.stringify(obj), "EX", this.opts.ttlSec);
    } catch {
      // falha do endpoint → mapa parcial/vazio; chamador degrada p/ id/label.
    }
    return map;
  }

  private async fetchAll(adAccountId: string, accessToken: string): Promise<RawCustomConversion[]> {
    const path = `${normalizeAdAccountId(adAccountId)}/customconversions`;
    const out: RawCustomConversion[] = [];
    let after: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const res = await this.opts.client.request<CustomConversionsPage>({
        method: "GET",
        path,
        accessToken,
        params: { fields: FIELDS, limit: PAGE_LIMIT, ...(after ? { after } : {}) },
      });
      out.push(...(res.data.data ?? []));
      after = res.data.paging?.next ? res.data.paging.cursors?.after : undefined;
      if (!after) break;
    }
    return out;
  }
}

function normalizeAdAccountId(id: string): string {
  return id.startsWith(AD_ACCOUNT_PREFIX) ? id : `${AD_ACCOUNT_PREFIX}${id}`;
}
