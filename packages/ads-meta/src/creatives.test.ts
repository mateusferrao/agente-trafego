import { afterEach, describe, expect, it, vi } from "vitest";
import { MetaGraphClient } from "./client.js";
import { CREATIVE_FIELDS, MetaCreativesService } from "./creatives.js";

const account = { adAccountId: "123", accessToken: "tok" };

/** Resposta do Batch API: array (na ordem das sub-requests) de { code, body:JSON-string }. */
function stubBatch(nodes: ReadonlyArray<Record<string, unknown> | null>) {
  const batch = nodes.map((node) =>
    node === null ? null : { code: 200, body: JSON.stringify(node) },
  );
  const spy = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
    new Response(JSON.stringify(batch), { status: 200, headers: { "content-type": "application/json" } }),
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
    const spy = stubBatch([]);
    expect(await makeService().getCreatives(account, [])).toEqual([]);
    expect(spy).not.toHaveBeenCalled();
  });

  it("normaliza (imagem/CTA) e cai no thumbnail p/ vídeo — via Batch API", async () => {
    const spy = stubBatch([
      { id: "AD1", creative: { id: "CR1", image_url: "http://img", body: "texto", call_to_action_type: "SHOP_NOW" } },
      { id: "AD2", creative: { thumbnail_url: "http://thumb", video_id: "V1" } },
    ]);

    const creatives = await makeService().getCreatives(account, ["AD1", "AD2"]);

    // POST no root com o parâmetro `batch` (não mais `?ids=`).
    const init = spy.mock.calls[0]![1]!;
    expect(init.method).toBe("POST");
    const form = new URLSearchParams(String(init.body));
    const sub = JSON.parse(form.get("batch") ?? "[]") as Array<{ relative_url: string }>;
    expect(sub.map((s) => s.relative_url)).toEqual([
      `AD1?fields=${encodeURIComponent(CREATIVE_FIELDS)}`,
      `AD2?fields=${encodeURIComponent(CREATIVE_FIELDS)}`,
    ]);

    expect(creatives).toContainEqual(
      expect.objectContaining({ adId: "AD1", imageUrl: "http://img", body: "texto", callToAction: "SHOP_NOW" }),
    );
    expect(creatives).toContainEqual(
      expect.objectContaining({ adId: "AD2", thumbnailUrl: "http://thumb", videoId: "V1" }),
    );
  });

  it("extrai copy do object_story_spec quando falta no top-level", async () => {
    stubBatch([
      {
        id: "AD3",
        creative: {
          object_story_spec: { link_data: { message: "corpo do anúncio", name: "manchete", call_to_action: { type: "LEARN_MORE" } } },
        },
      },
    ]);
    const [c] = await makeService().getCreatives(account, ["AD3"]);
    expect(c).toMatchObject({ adId: "AD3", body: "corpo do anúncio", title: "manchete", callToAction: "LEARN_MORE" });
  });

  it("sub-request que falhou (code != 200 ou null) é pulada, não derruba o lote", async () => {
    stubBatch([
      { id: "AD1", creative: { image_url: "http://img" } },
      null,
    ]);
    const creatives = await makeService().getCreatives(account, ["AD1", "AD2"]);
    expect(creatives).toHaveLength(1);
    expect(creatives[0]).toMatchObject({ adId: "AD1", imageUrl: "http://img" });
  });
});
