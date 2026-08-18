import type { Creative } from "@trafego/shared/types";
import type { AdAccountRef } from "@trafego/shared/ports";
import type { MetaGraphClient } from "./client.js";

/**
 * Resolução de criativos p/ visão (§9): usar `image_url`/`thumbnail_url` (confiáveis).
 * Vídeo `source` é incerto → cai no `thumbnail_url`.
 *
 * Busca em batch os adcreatives dos ads informados e normaliza p/ `Creative`.
 */
export class MetaCreativesService {
  private readonly client: MetaGraphClient;

  constructor(client: MetaGraphClient) {
    this.client = client;
  }

  /** Resolve os criativos dos ads (batched, ≤50 por HTTP). */
  getCreatives(account: AdAccountRef, adIds: readonly string[]): Promise<Creative[]> {
    // TODO: batch GET {ad_id}?fields=creative{...,image_url,thumbnail_url,object_story_spec}
    //       + normalizar → preferir image_url; fallback thumbnail_url p/ vídeo.
    throw new Error("not implemented");
  }

  /** Normaliza um adcreative cru da Meta em Creative do domínio. */
  normalizeCreative(adId: string, raw: Readonly<Record<string, unknown>>): Creative {
    // TODO: extrair body/title/call_to_action/image_url/thumbnail_url/video_id.
    throw new Error("not implemented");
  }
}
