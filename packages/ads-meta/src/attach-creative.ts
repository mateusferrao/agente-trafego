// Anexar um asset da biblioteca a um adset EXISTENTE = CLONAR o molde (object_story_spec) de um
// anúncio que já roda no conjunto e TROCAR só a mídia (+ copy, se pedido). Clonar o molde cru (em vez
// de remontar campo-a-campo) preserva destino/CTA/página E o formulário de leads (`lead_gen_form_id`,
// que mora dentro do call_to_action) — cobre site, CTWA e formulário com fidelidade. PURA, sem IO:
// os bytes/capa do vídeo e o molde vêm resolvidos na casca. Vocabulário Meta fica só aqui no adapter.

import type { RawObjectStorySpec } from "./creative-select.js";

/** Mídia nova a injetar no molde. Vídeo carrega a capa (a Meta exige image no video_data). */
export type SwapMedia =
  | { readonly kind: "image"; readonly imageHash: string }
  | { readonly kind: "video"; readonly videoId: string; readonly coverImageUrl: string };

/** Sobrescrita opcional da copy (senão herda a do molde). */
export interface CopyOverride {
  readonly primaryText?: string;
  readonly headline?: string;
}

export interface SwapResult {
  readonly spec: RawObjectStorySpec;
  /** true quando o tipo do molde ≠ o tipo do asset (reestruturou link_data↔video_data) — o eco avisa. */
  readonly restructured: boolean;
}

type Obj = Record<string, unknown>;

/** Tipo de mídia do molde (só imagem/vídeo únicos chegam aqui — isReusableCreative barra o resto). */
function templateKind(spec: Obj): "image" | "video" | null {
  if ((spec["video_data"] as Obj | undefined)?.["video_id"]) return "video";
  if ((spec["link_data"] as Obj | undefined)?.["image_hash"]) return "image";
  return null;
}

/**
 * Troca a mídia do molde preservando destino/copy/CTA/página/formulário. Mesmo tipo (imagem→imagem,
 * vídeo→vídeo) = troca direta (spread do sub-objeto + novo id/capa). Tipo diferente (imagem↔vídeo) =
 * REESTRUTURA `link_data`↔`video_data` carregando message, headline (name↔title), o call_to_action
 * (com o link de destino e o lead_gen_form_id) e o page_id do topo; marca `restructured` pro eco.
 */
export function swapMediaInStorySpec(template: RawObjectStorySpec, media: SwapMedia, copyOverride?: CopyOverride): SwapResult {
  const clone = structuredClone(template) as unknown as Obj;
  const from = templateKind(clone);
  const restructured = from !== null && from !== media.kind;

  const linkData = (clone["link_data"] as Obj | undefined) ?? {};
  const videoData = (clone["video_data"] as Obj | undefined) ?? {};
  const srcSub: Obj = clone["video_data"] ? videoData : linkData; // o sub-objeto que TEM a mídia hoje

  const message = copyOverride?.primaryText ?? (srcSub["message"] as string | undefined);
  const headline = copyOverride?.headline ?? (linkData["name"] as string | undefined) ?? (videoData["title"] as string | undefined);
  const cta = srcSub["call_to_action"]; // carrega destino + lead_gen_form_id
  const imageDestLink = linkData["link"] as string | undefined; // o link de site mora em link_data.link

  // base = tudo menos as duas sub-mídias (page_id + extras do topo ficam intactos).
  const { link_data: _l, video_data: _v, ...base } = clone;

  if (media.kind === "image") {
    const link_data: Obj = {
      ...(restructured ? {} : linkData), // mesmo tipo: preserva o link_data inteiro; reestrutura: começa limpo
      image_hash: media.imageHash,
      ...(message !== undefined ? { message } : {}),
      ...(headline !== undefined ? { name: headline } : {}),
      ...(cta !== undefined ? { call_to_action: cta } : {}),
    };
    return { spec: { ...base, link_data } as unknown as RawObjectStorySpec, restructured };
  }

  const video_data: Obj = {
    ...(restructured ? {} : videoData),
    video_id: media.videoId,
    image_url: media.coverImageUrl, // capa obrigatória (derivada do vídeo na casca)
    ...(message !== undefined ? { message } : {}),
    ...(headline !== undefined ? { title: headline } : {}),
    ...(cta !== undefined ? { call_to_action: cta } : {}),
  };
  // reestrutura de imagem: o link de destino (link_data.link) migra pro call_to_action do vídeo.
  if (restructured && imageDestLink !== undefined) {
    const existing = (video_data["call_to_action"] as { type?: string; value?: Obj } | undefined) ?? {};
    video_data["call_to_action"] = { ...existing, value: { ...(existing.value ?? {}), link: imageDestLink } };
  }
  return { spec: { ...base, video_data } as unknown as RawObjectStorySpec, restructured };
}
