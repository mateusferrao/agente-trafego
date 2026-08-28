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

/** Frames HD do vídeo (Fatia 6c): a Meta entrega ~10 thumbnails 1080p ao longo do vídeo. */
export const VIDEO_THUMBNAILS_FIELDS = "thumbnails{uri,width,height,is_preferred}";

/** Quantos frames HD amostrar por criativo de vídeo (default; override na composição). */
export const DEFAULT_VISION_FRAMES = 4;

interface RawVideoThumb {
  readonly uri?: string;
  readonly is_preferred?: boolean;
}

/**
 * Escolhe N frames ESPAÇADOS (abertura → fim), dedupe por uri. Prioriza incluir o
 * `is_preferred` (a capa que a Meta considera melhor) sem perder a cobertura.
 */
export function pickSpacedFrames(thumbs: readonly RawVideoThumb[], n: number): string[] {
  const uris = [...new Set(thumbs.map((t) => t.uri).filter((u): u is string => !!u))];
  if (uris.length === 0 || n <= 0) return [];
  if (uris.length <= n) return uris;
  const step = (uris.length - 1) / (n - 1);
  const picked = new Set<string>();
  for (let i = 0; i < n; i++) picked.add(uris[Math.round(i * step)]!);
  return [...picked];
}

interface RawObjectStorySpec {
  readonly link_data?: { readonly message?: string; readonly name?: string; readonly image_hash?: string; readonly call_to_action?: { readonly type?: string } };
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
  private readonly framesPerVideo: number;

  constructor(client: MetaGraphClient, governor: MetaGovernor, framesPerVideo: number = DEFAULT_VISION_FRAMES) {
    this.client = client;
    this.governor = governor;
    this.framesPerVideo = Math.max(1, framesPerVideo);
  }

  /** Frames HD de UM vídeo (por video_id) — reuso da biblioteca p/ a visão de criativo. */
  async videoFrames(account: AdAccountRef, videoId: string): Promise<string[]> {
    const accountId = normalizeAdAccountId(account.adAccountId);
    const byVideo = await this.fetchVideoFrames(account, accountId, [videoId]);
    return byVideo.get(videoId) ?? [];
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
    return this.withPosterFrames(account, accountId, out);
  }

  /**
   * Anexa `posterFrames` (Fatia 6c): imagem = [image_url]; vídeo = N frames HD via
   * 2º Batch (`/{video_id}?fields=thumbnails`). Frames HD (1080p) substituem o selo
   * pequeno do `thumbnail_url`. Degrada pro still único se a busca falhar.
   */
  private async withPosterFrames(account: AdAccountRef, accountId: string, creatives: readonly Creative[]): Promise<Creative[]> {
    const videoIds = [...new Set(creatives.map((c) => c.videoId).filter((v): v is string => !!v))];
    const framesByVideo = videoIds.length > 0 ? await this.fetchVideoFrames(account, accountId, videoIds) : new Map<string, string[]>();
    return creatives.map((c) => {
      const frames = c.videoId ? framesByVideo.get(c.videoId) : undefined;
      const fallback = c.imageUrl ?? c.thumbnailUrl;
      const posterFrames = frames && frames.length > 0 ? frames : fallback ? [fallback] : [];
      return posterFrames.length > 0 ? { ...c, posterFrames } : c;
    });
  }

  /** Busca os thumbnails HD de cada vídeo (Batch) e amostra N frames espaçados. */
  private async fetchVideoFrames(account: AdAccountRef, accountId: string, videoIds: readonly string[]): Promise<Map<string, string[]>> {
    const requests: BatchSubRequest[] = videoIds.map((id) => ({
      method: "GET",
      relativeUrl: `${id}?fields=${encodeURIComponent(VIDEO_THUMBNAILS_FIELDS)}`,
    }));
    const subs = await callWithGovernor<Array<BatchSubResponse | null>>(
      accountId,
      () => this.client.batch(account.accessToken, requests),
      { governor: this.governor },
    );
    const byVideo = new Map<string, string[]>();
    subs.forEach((sub, i) => {
      const videoId = videoIds[i];
      if (!videoId || !sub || sub.code !== 200) return;
      try {
        const node = JSON.parse(sub.body) as { thumbnails?: { data?: RawVideoThumb[] } };
        const frames = pickSpacedFrames(node.thumbnails?.data ?? [], this.framesPerVideo);
        if (frames.length > 0) byVideo.set(videoId, frames);
      } catch {
        // corpo malformado → sem frames HD p/ esse vídeo (cai no still no chamador)
      }
    });
    return byVideo;
  }

  /** Normaliza um adcreative cru → Creative do domínio (top-level + fallback object_story_spec). */
  normalizeCreative(adId: string, c: RawCreative): Creative {
    const story = c.object_story_spec?.link_data ?? c.object_story_spec?.video_data;
    const body = c.body ?? story?.message;
    const title = c.title ?? (c.object_story_spec?.link_data?.name || c.object_story_spec?.video_data?.title);
    const callToAction = c.call_to_action_type ?? story?.call_to_action?.type;
    const imageHash = c.object_story_spec?.link_data?.image_hash;
    return {
      id: c.id ?? adId,
      adId,
      ...(c.name ? { name: c.name } : {}),
      ...(body ? { body } : {}),
      ...(title ? { title } : {}),
      ...(callToAction ? { callToAction } : {}),
      ...(c.image_url ? { imageUrl: c.image_url } : {}),
      ...(imageHash ? { imageHash } : {}),
      ...(c.thumbnail_url ? { thumbnailUrl: c.thumbnail_url } : {}),
      ...(c.video_id ? { videoId: c.video_id } : {}),
    };
  }
}
