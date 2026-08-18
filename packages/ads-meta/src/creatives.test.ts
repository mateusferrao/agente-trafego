import { afterEach, describe, expect, it, vi } from "vitest";
import { MetaGraphClient } from "./client.js";
import { MetaCreativesService } from "./creatives.js";

const account = { adAccountId: "123", accessToken: "tok" };

function stub(body: unknown) {
  const spy = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
    new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } }),
  );
  vi.stubGlobal("fetch", spy);
  return spy;
}

afterEach(() => vi.unstubAllGlobals());

function makeService(): MetaCreativesService {
  return new MetaCreativesService(new MetaGraphClient({ graphVersion: "v26.0" }));
}

describe("MetaCreativesService.getCreatives", () => {
  it("lista vazia → sem chamada", async () => {
    const spy = stub({});
    expect(await makeService().getCreatives(account, [])).toEqual([]);
    expect(spy).not.toHaveBeenCalled();
  });

  it("normaliza (imagem/CTA) e cai no thumbnail p/ vídeo", async () => {
    const spy = stub({
      AD1: { creative: { id: "CR1", image_url: "http://img", body: "texto", call_to_action_type: "SHOP_NOW" } },
      AD2: { creative: { thumbnail_url: "http://thumb", video_id: "V1" } },
    });

    const creatives = await makeService().getCreatives(account, ["AD1", "AD2"]);

    // chamada via ?ids=
    const url = new URL(String(spy.mock.calls[0]![0]));
    expect(url.searchParams.get("ids")).toBe("AD1,AD2");

    expect(creatives).toContainEqual(
      expect.objectContaining({ adId: "AD1", imageUrl: "http://img", body: "texto", callToAction: "SHOP_NOW" }),
    );
    expect(creatives).toContainEqual(
      expect.objectContaining({ adId: "AD2", thumbnailUrl: "http://thumb", videoId: "V1" }),
    );
  });

  it("extrai copy do object_story_spec quando falta no top-level", async () => {
    stub({
      AD3: {
        creative: {
          object_story_spec: { link_data: { message: "corpo do anúncio", name: "manchete", call_to_action: { type: "LEARN_MORE" } } },
        },
      },
    });
    const [c] = await makeService().getCreatives(account, ["AD3"]);
    expect(c).toMatchObject({ adId: "AD3", body: "corpo do anúncio", title: "manchete", callToAction: "LEARN_MORE" });
  });
});
