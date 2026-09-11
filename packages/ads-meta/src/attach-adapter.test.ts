import { afterEach, describe, expect, it, vi } from "vitest";
import { MetaGraphClient } from "./client.js";
import { MetaCreationService } from "./creation.js";

const account = { adAccountId: "act_123", accessToken: "tok" };
const service = () => new MetaCreationService(new MetaGraphClient({ graphVersion: "v26.0" }));

afterEach(() => vi.unstubAllGlobals());

/** Roteia o fetch por URL (GET adset/ads, GET molde, GET thumbnails, POST adcreatives). */
function stub(bodies: { ads?: unknown; template?: unknown; thumbnails?: unknown; created?: unknown }) {
  const calls: string[] = [];
  const spy = vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    const pick = url.includes("/adcreatives")
      ? bodies.created ?? { id: "CREATIVE_NEW" }
      : url.includes("/ads?") || url.endsWith("/ads")
        ? bodies.ads ?? { data: [] }
        : url.includes("thumbnails")
          ? bodies.thumbnails ?? { thumbnails: { data: [{ uri: "https://cdn/cover.jpg", is_preferred: true }] } }
          : bodies.template ?? { creative: {} };
    return new Response(JSON.stringify(pick), { status: 200, headers: { "content-type": "application/json" } });
  });
  vi.stubGlobal("fetch", spy);
  return { calls: () => calls };
}

describe("MetaCreationService.readAdSetAds", () => {
  it("mapeia id/creativeId/status/formato (imagem × vídeo) dos anúncios do conjunto", async () => {
    stub({
      ads: {
        data: [
          { id: "AD1", name: "img", effective_status: "ACTIVE", creative: { id: "CR1", object_story_spec: { link_data: { image_hash: "H" } } } },
          { id: "AD2", effective_status: "PAUSED", creative: { id: "CR2", object_story_spec: { video_data: { video_id: "V" } } } },
        ],
      },
    });
    const out = await service().readAdSetAds(account, "ADSET1");
    expect(out).toEqual([
      { adId: "AD1", creativeId: "CR1", name: "img", status: "active", format: "image" },
      { adId: "AD2", creativeId: "CR2", status: "paused", format: "video" },
    ]);
  });
});

describe("MetaCreationService.createAdCreativeFromTemplate", () => {
  it("clona o molde de IMAGEM e troca por VÍDEO (reestrutura link→video_data + capa), retorna o creativeId", async () => {
    const s = stub({
      template: { creative: { object_story_spec: { page_id: "P", link_data: { image_hash: "OLD", link: "https://x", message: "m", name: "h", call_to_action: { value: { link: "https://x", lead_gen_form_id: "F1" } } } } } },
    });
    const out = await service().createAdCreativeFromTemplate(account, {
      templateAdId: "TEMPLATEAD",
      media: { kind: "video", videoId: "VIDNEW" },
      name: "novo anúncio",
    });
    expect(out).toEqual({ creativeId: "CREATIVE_NEW" });
    // o POST em /adcreatives carrega o object_story_spec clonado com a mídia trocada.
    const postUrl = s.calls().find((u) => u.includes("/adcreatives"))!;
    const spec = JSON.parse(new URL(postUrl).searchParams.get("object_story_spec")!);
    expect(spec.video_data.video_id).toBe("VIDNEW");
    expect(spec.video_data.image_url).toBe("https://cdn/cover.jpg");
    expect(spec.video_data.message).toBe("m");
    expect(spec.video_data.call_to_action.value.lead_gen_form_id).toBe("F1"); // formulário preservado
    expect(spec.link_data).toBeUndefined(); // reestruturado
    expect(spec.page_id).toBe("P");
  });

  it("molde sem object_story_spec → erro claro (não dá pra clonar)", async () => {
    stub({ template: { creative: {} } });
    await expect(
      service().createAdCreativeFromTemplate(account, { templateAdId: "T", media: { kind: "image", imageHash: "H" }, name: "n" }),
    ).rejects.toThrow(/não dá pra clonar/);
  });
});
