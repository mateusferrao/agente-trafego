import type { InterestSearchResult } from "@trafego/shared";
import type { AdAccountRef } from "@trafego/shared/ports";
import type { MetaGraphClient } from "./client.js";
import { callWithGovernor } from "./call-with-governor.js";
import type { MetaGovernor } from "./governor.js";
import { normalizeAdAccountId } from "./ids.js";

/**
 * Busca de interesse (Fase 2, subfatia 4) — `/search?type=adinterest` (endpoint GLOBAL da Graph
 * API, busca por texto livre no SERVIDOR — diferente de behaviors/`adTargetingCategory`, que é
 * enumeração sem busca; por isso vive num arquivo próprio, não junto do geo-search). Vocabulário
 * Meta isolado aqui; devolve a taxonomia neutra `InterestSearchResult`.
 */
const INTEREST_SEARCH_LIMIT = 10;

interface RawInterestResult {
  readonly id?: string;
  readonly name?: string;
  readonly audience_size_lower_bound?: number;
  readonly path?: readonly string[];
}
interface RawInterestSearchResponse {
  readonly data?: readonly RawInterestResult[];
}

export class MetaInterestSearchService {
  private readonly client: MetaGraphClient;
  private readonly governor: MetaGovernor;

  constructor(client: MetaGraphClient, governor: MetaGovernor) {
    this.client = client;
    this.governor = governor;
  }

  async search(account: AdAccountRef, query: string): Promise<InterestSearchResult[]> {
    if (!query.trim()) return [];
    const accountId = normalizeAdAccountId(account.adAccountId);
    const data = await callWithGovernor(
      accountId,
      () =>
        this.client.request<RawInterestSearchResponse>({
          method: "GET",
          path: "search",
          accessToken: account.accessToken,
          params: { type: "adinterest", q: query, limit: INTEREST_SEARCH_LIMIT, locale: "pt_BR" },
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
    return out;
  }
}
