import type { Creative } from "@trafego/shared/types";
import type { AdAccountRef } from "@trafego/shared/ports";
import type { BatchSubRequest, BatchSubResponse, MetaGraphClient } from "./client.js";
import { callWithGovernor } from "./call-with-governor.js";
import type { MetaGovernor } from "./governor.js";
import { normalizeAdAccountId } from "./ids.js";

/**
 * Resolução de criativos p/ visão (§9): usar `image_url`/`thumbnail_url` (confiáveis).
 * Vídeo `image_url` costuma faltar → cai no `thumbnail_url`. Busca cada ad via **Batch
 * API** (1 sub-GET `/{adId}?fields=creative{…}` por ad, ≤50 por HTTP) — o `?ids=`
 * multi-read foi **deprecado na Graph v26+**. Normaliza o `creative` embutido.
 */

export const CREATIVE_FIELDS =
  "creative{id,name,image_url,thumbnail_url,object_story_spec,body,title,call_to_action_type,video_id}";

interface RawObjectStorySpec {
  readonly link_data?: { readonly message?: string; readonly name?: string; readonly call_to_action?: { readonly type?: string } };
  readonly video_data?: { readonly message?: string; readonly title?: string; readonly call_to_action?: { readonly type?: string } };
}

interface RawCreative {
  readonly id?: string;
  readonly name?: string;
  readonly image_url?: string;
  readonly thumbnail_url?: string;
  readonly body?: string;
  readonly title?: string;
  readonly call_to_action_type?: string;
  readonly video_id?: string;
  readonly object_story_spec?: RawObjectStorySpec;
}

interface RawAdWithCreative {
  readonly creative?: RawCreative;
}

export class MetaCreativesService {
  private readonly client: MetaGraphClient;
  private readonly governor: MetaGovernor;

  constructor(client: MetaGraphClient, governor: MetaGovernor) {
    this.client = client;
    this.governor = governor;
  }

  /** Resolve os criativos dos ads via Batch API (1 sub-GET por ad, ≤50 por HTTP). */
  async getCreatives(account: AdAccountRef, adIds: readonly string[]): Promise<Creative[]> {
    if (adIds.length === 0) return [];
    const requests: BatchSubRequest[] = adIds.map((id) => ({
      method: "GET",
      relativeUrl: `${id}?fields=${encodeURIComponent(CREATIVE_FIELDS)}`,
    }));
    const accountId = normalizeAdAccountId(account.adAccountId);
    const subs = await callWithGovernor<Array<BatchSubResponse | null>>(
      accountId,
      () => this.client.batch(account.accessToken, requests),
      { governor: this.governor },
    );
    const out: Creative[] = [];
    // resposta na ordem das sub-requests → casa por índice com adIds.
    subs.forEach((sub, i) => {
      const adId = adIds[i];
      if (!adId || !sub || sub.code !== 200) return;
      let node: RawAdWithCreative;
      try {
        node = JSON.parse(sub.body) as RawAdWithCreative;
      } catch {
        return; // sub-corpo malformado → pula esse ad (não derruba o lote)
      }
      if (node.creative) out.push(this.normalizeCreative(adId, node.creative));
    });
    return out;
  }

  /** Normaliza um adcreative cru → Creative do domínio (top-level + fallback object_story_spec). */
  normalizeCreative(adId: string, c: RawCreative): Creative {
    const story = c.object_story_spec?.link_data ?? c.object_story_spec?.video_data;
    const body = c.body ?? story?.message;
    const title = c.title ?? (c.object_story_spec?.link_data?.name || c.object_story_spec?.video_data?.title);
    const callToAction = c.call_to_action_type ?? story?.call_to_action?.type;
    return {
      id: c.id ?? adId,
      adId,
      ...(c.name ? { name: c.name } : {}),
      ...(body ? { body } : {}),
      ...(title ? { title } : {}),
      ...(callToAction ? { callToAction } : {}),
      ...(c.image_url ? { imageUrl: c.image_url } : {}),
      ...(c.thumbnail_url ? { thumbnailUrl: c.thumbnail_url } : {}),
      ...(c.video_id ? { videoId: c.video_id } : {}),
    };
  }
}
