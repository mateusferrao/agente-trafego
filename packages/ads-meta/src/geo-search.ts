import type { GeoSearchResult } from "@trafego/shared";
import type { AdAccountRef } from "@trafego/shared/ports";
import type { MetaGraphClient } from "./client.js";
import { callWithGovernor } from "./call-with-governor.js";
import type { MetaGovernor } from "./governor.js";
import { normalizeAdAccountId } from "./ids.js";

/**
 * Busca de geo (Fase 1, subfatia 3) — `/search?type=adgeolocation` (endpoint GLOBAL da Graph API,
 * não escopado por ad account). Vocabulário Meta (`location_types`/`supports_city`/`supports_region`)
 * isolado aqui; devolve a taxonomia neutra `GeoSearchResult`. Confirmado contra doc oficial
 * (sessão de planejamento): resposta tem `key`/`name`/`type`, sem `country_code` garantido — trata
 * como opcional.
 */
const GEO_SEARCH_LIMIT = 10;
const META_LOCATION_TYPES = { country: "country", region: "region", city: "city" } as const;

interface RawGeoResult {
  readonly key?: string;
  readonly name?: string;
  readonly type?: string;
  readonly country_code?: string;
}
interface RawGeoSearchResponse {
  readonly data?: readonly RawGeoResult[];
}

export class MetaGeoSearchService {
  private readonly client: MetaGraphClient;
  private readonly governor: MetaGovernor;

  constructor(client: MetaGraphClient, governor: MetaGovernor) {
    this.client = client;
    this.governor = governor;
  }

  async search(account: AdAccountRef, query: string, locationTypes: readonly ("country" | "region" | "city")[]): Promise<GeoSearchResult[]> {
    if (!query.trim() || locationTypes.length === 0) return [];
    const accountId = normalizeAdAccountId(account.adAccountId);
    const data = await callWithGovernor(
      accountId,
      () =>
        this.client.request<RawGeoSearchResponse>({
          method: "GET",
          path: "search",
          accessToken: account.accessToken,
          params: {
            type: "adgeolocation",
            q: query,
            location_types: JSON.stringify(locationTypes.map((t) => META_LOCATION_TYPES[t])),
            limit: GEO_SEARCH_LIMIT,
          },
        }),
      { governor: this.governor },
    );
    const out: GeoSearchResult[] = [];
    for (const r of data.data ?? []) {
      if (!r.key || !r.name || (r.type !== "country" && r.type !== "region" && r.type !== "city")) continue;
      out.push({ key: r.key, name: r.name, kind: r.type, ...(r.country_code ? { countryCode: r.country_code } : {}) });
    }
    return out;
  }
}
