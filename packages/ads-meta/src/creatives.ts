import type { Creative } from "@trafego/shared/types";
import type { AdAccountRef } from "@trafego/shared/ports";
import type { MetaGraphClient } from "./client.js";

/**
 * Resolução de criativos p/ visão (§9): usar `image_url`/`thumbnail_url` (confiáveis).
 * Vídeo `image_url` costuma faltar → cai no `thumbnail_url`. Busca os ads via `?ids=`
 * (≤50 por HTTP) e normaliza o `creative` embutido.
 */

const CHUNK_SIZE = 50;
const CREATIVE_FIELDS =
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

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export class MetaCreativesService {
  private readonly client: MetaGraphClient;

  constructor(client: MetaGraphClient) {
    this.client = client;
  }

  /** Resolve os criativos dos ads (via `?ids=`, ≤50 por HTTP). */
  async getCreatives(account: AdAccountRef, adIds: readonly string[]): Promise<Creative[]> {
    if (adIds.length === 0) return [];
    const out: Creative[] = [];
    for (const ids of chunk(adIds, CHUNK_SIZE)) {
      const res = await this.client.request<Record<string, RawAdWithCreative>>({
        method: "GET",
        path: "",
        accessToken: account.accessToken,
        params: { ids: ids.join(","), fields: CREATIVE_FIELDS },
      });
      for (const [adId, node] of Object.entries(res.data)) {
        if (node?.creative) out.push(this.normalizeCreative(adId, node.creative));
      }
    }
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
