import { describe, expect, it } from "vitest";
import { swapMediaInStorySpec } from "./attach-creative.js";
import type { RawObjectStorySpec } from "./creative-select.js";

// molde cru como vem da Graph — inclui campos não modelados (lead_gen_form_id no call_to_action.value).
const imageTemplate = {
  page_id: "PAGE1",
  link_data: {
    image_hash: "OLDHASH",
    link: "https://loja.com/oferta",
    message: "texto do anúncio de imagem",
    name: "Compre agora",
    call_to_action: { type: "SIGN_UP", value: { link: "https://loja.com/oferta", lead_gen_form_id: "FORM99" } },
  },
} as unknown as RawObjectStorySpec;

const videoTemplate = {
  page_id: "PAGE1",
  video_data: {
    video_id: "OLDVID",
    message: "texto do anúncio de vídeo",
    title: "Assista",
    image_hash: "OLDCOVER",
    call_to_action: { value: { link: "https://loja.com/video" } },
  },
} as unknown as RawObjectStorySpec;

function link(spec: RawObjectStorySpec) {
  return spec.link_data as Record<string, unknown> | undefined;
}
function video(spec: RawObjectStorySpec) {
  return spec.video_data as Record<string, unknown> | undefined;
}

describe("swapMediaInStorySpec", () => {
  it("imagem→imagem: troca só o image_hash, preserva link/copy/CTA/página, sem reestruturar", () => {
    const { spec, restructured } = swapMediaInStorySpec(imageTemplate, { kind: "image", imageHash: "NEWHASH" });
    expect(restructured).toBe(false);
    expect(link(spec)!["image_hash"]).toBe("NEWHASH");
    expect(link(spec)!["link"]).toBe("https://loja.com/oferta");
    expect(link(spec)!["message"]).toBe("texto do anúncio de imagem");
    expect(link(spec)!["call_to_action"]).toMatchObject({ value: { lead_gen_form_id: "FORM99" } });
    expect(spec.page_id).toBe("PAGE1");
    expect(video(spec)).toBeUndefined();
  });

  it("vídeo→vídeo: troca video_id + capa (image_url), preserva message/title/CTA", () => {
    const { spec, restructured } = swapMediaInStorySpec(videoTemplate, { kind: "video", videoId: "NEWVID", coverImageUrl: "https://cdn/cover.jpg" });
    expect(restructured).toBe(false);
    expect(video(spec)!["video_id"]).toBe("NEWVID");
    expect(video(spec)!["image_url"]).toBe("https://cdn/cover.jpg");
    expect(video(spec)!["message"]).toBe("texto do anúncio de vídeo");
    expect(video(spec)!["title"]).toBe("Assista");
    expect(video(spec)!["call_to_action"]).toMatchObject({ value: { link: "https://loja.com/video" } });
    expect(link(spec)).toBeUndefined();
  });

  it("imagem→vídeo: REESTRUTURA link_data→video_data, carrega copy/headline/CTA(form)/link/página", () => {
    const { spec, restructured } = swapMediaInStorySpec(imageTemplate, { kind: "video", videoId: "V2", coverImageUrl: "https://cdn/c.jpg" });
    expect(restructured).toBe(true);
    expect(link(spec)).toBeUndefined(); // não sobra link_data
    expect(video(spec)!["video_id"]).toBe("V2");
    expect(video(spec)!["image_url"]).toBe("https://cdn/c.jpg");
    expect(video(spec)!["message"]).toBe("texto do anúncio de imagem");
    expect(video(spec)!["title"]).toBe("Compre agora"); // name → title
    // o formulário de leads (dentro do CTA) sobrevive à reestruturação
    expect(video(spec)!["call_to_action"]).toMatchObject({ value: { lead_gen_form_id: "FORM99", link: "https://loja.com/oferta" } });
    expect(spec.page_id).toBe("PAGE1");
  });

  it("vídeo→imagem: REESTRUTURA video_data→link_data, carrega message/title→name/CTA", () => {
    const { spec, restructured } = swapMediaInStorySpec(videoTemplate, { kind: "image", imageHash: "H2" });
    expect(restructured).toBe(true);
    expect(video(spec)).toBeUndefined();
    expect(link(spec)!["image_hash"]).toBe("H2");
    expect(link(spec)!["message"]).toBe("texto do anúncio de vídeo");
    expect(link(spec)!["name"]).toBe("Assista"); // title → name
    expect(link(spec)!["call_to_action"]).toMatchObject({ value: { link: "https://loja.com/video" } });
  });

  it("copyOverride sobrescreve message/headline sem tocar no resto", () => {
    const { spec } = swapMediaInStorySpec(imageTemplate, { kind: "image", imageHash: "NEWHASH" }, { primaryText: "novo texto", headline: "novo título" });
    expect(link(spec)!["message"]).toBe("novo texto");
    expect(link(spec)!["name"]).toBe("novo título");
    expect(link(spec)!["image_hash"]).toBe("NEWHASH");
    expect(link(spec)!["call_to_action"]).toMatchObject({ value: { lead_gen_form_id: "FORM99" } });
  });

  it("não muta o molde de entrada (clone)", () => {
    swapMediaInStorySpec(imageTemplate, { kind: "image", imageHash: "NEWHASH" });
    expect(imageTemplate.link_data!.image_hash).toBe("OLDHASH");
  });
});
