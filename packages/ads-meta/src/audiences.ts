import type { CustomAudience } from "@trafego/shared";
import type { AdAccountRef } from "@trafego/shared/ports";
import type { MetaGraphClient } from "./client.js";
import { callWithGovernor } from "./call-with-governor.js";
import type { MetaGovernor } from "./governor.js";
import { normalizeAdAccountId } from "./ids.js";
import { isLookalikeName } from "./meta-audience-map.js";

/**
 * Lista os custom/saved audiences da conta (Fatia 7) — p/ remarketing/exclusões REAIS (o
 * agente parava de chutar públicos). Vocabulário Meta (`subtype`/edge `/customaudiences`)
 * isolado aqui; devolve a taxonomia neutra `CustomAudience`. Google/TikTok = outro adapter.
 */
export const CUSTOM_AUDIENCE_FIELDS = "id,name,subtype,approximate_count_lower_bound,approximate_count_upper_bound";
/** Página grande — a lista de públicos costuma ser pequena; poucos round-trips. */
const AUDIENCE_PAGE_LIMIT = 200;
/** Trava de paginação. */
const MAX_AUDIENCE_PAGES = 25;

interface RawAudience {
  readonly id?: string;
  readonly name?: string;
  readonly subtype?: string;
  readonly approximate_count_lower_bound?: number;
  readonly approximate_count_upper_bound?: number;
}
interface RawAudiencePage {
  readonly data?: readonly RawAudience[];
  readonly paging?: { readonly next?: string; readonly cursors?: { readonly after?: string } };
}

const LOOKALIKE_SUBTYPE = "LOOKALIKE";

export class MetaAudiencesService {
  private readonly client: MetaGraphClient;
  private readonly governor: MetaGovernor;

  constructor(client: MetaGraphClient, governor: MetaGovernor) {
    this.client = client;
    this.governor = governor;
  }

  async list(account: AdAccountRef): Promise<CustomAudience[]> {
    const accountId = normalizeAdAccountId(account.adAccountId);
    const out: CustomAudience[] = [];
    let after: string | undefined;
    for (let page = 0; page < MAX_AUDIENCE_PAGES; page++) {
      const data = await callWithGovernor(
        accountId,
        () =>
          this.client.request<RawAudiencePage>({
            method: "GET",
            path: `${accountId}/customaudiences`,
            accessToken: account.accessToken,
            params: { fields: CUSTOM_AUDIENCE_FIELDS, limit: AUDIENCE_PAGE_LIMIT, ...(after ? { after } : {}) },
          }),
        { governor: this.governor },
      );
      for (const a of data.data ?? []) {
        if (!a.id) continue;
        out.push({
          id: a.id,
          name: a.name ?? a.id,
          ...(a.subtype ? { subtype: a.subtype.toLowerCase() } : {}),
          ...(typeof a.approximate_count_lower_bound === "number" ? { approximateCount: a.approximate_count_lower_bound } : {}),
          isLookalike: a.subtype === LOOKALIKE_SUBTYPE || isLookalikeName(a.name),
        });
      }
      after = data.paging?.next ? data.paging.cursors?.after : undefined;
      if (!after) break;
    }
    return out;
  }
}
