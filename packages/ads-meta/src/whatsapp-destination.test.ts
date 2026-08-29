import { afterEach, describe, expect, it, vi } from "vitest";
import type { Redis } from "ioredis";
import { MetaGraphClient } from "./client.js";
import { MetaCreativesService } from "./creatives.js";
import { MetaGovernor } from "./governor.js";
import { MetaWhatsappDestinationService } from "./whatsapp-destination.js";

class FakeRedis {
  private store = new Map<string, { value: string; expiresAt: number | null }>();
  async set(key: string, value: string, mode?: string, ttlSec?: number): Promise<"OK"> {
    this.store.set(key, { value, expiresAt: mode === "EX" && ttlSec ? Date.now() + ttlSec * 1000 : null });
    return "OK";
  }
  async pttl(key: string): Promise<number> {
    const e = this.store.get(key);
    if (!e) return -2;
    if (e.expiresAt === null) return -1;
    const ms = e.expiresAt - Date.now();
    return ms > 0 ? ms : -2;
  }
}

const account = { adAccountId: "123", accessToken: "tok" };

/** Roteia o fetch por URL/método: ads-da-campanha, batch de criativos, página, nome. */
function stubGraph(opts: {
  adIds: string[];
  creativeByAd: Record<string, Record<string, unknown>>;
  pageWhatsapp?: string;
  campaignName?: string;
}): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
      if (method === "POST") {
        // Batch API (getCreatives): 1 sub por ad, na ordem.
        const form = new URLSearchParams(String(init?.body));
        const subs = JSON.parse(form.get("batch") ?? "[]") as Array<{ relative_url: string }>;
        const batch = subs.map((s) => {
          const adId = s.relative_url.split("?")[0]!;
          const node = opts.creativeByAd[adId];
          return node ? { code: 200, body: JSON.stringify({ creative: node }) } : null;
        });
        return json(batch);
      }
      if (url.includes("/ads?") || url.endsWith("/ads")) return json({ data: opts.adIds.map((id) => ({ id })) });
      if (url.includes("fields=whatsapp_number")) return json({ whatsapp_number: opts.pageWhatsapp ?? "" });
      if (url.includes("fields=name")) return json({ name: opts.campaignName ?? "" });
      return json({});
    }),
  );
}

afterEach(() => vi.unstubAllGlobals());

function makeService(): MetaWhatsappDestinationService {
  const gov = new MetaGovernor({ redis: new FakeRedis() as unknown as Redis, rng: () => 0 });
  const client = new MetaGraphClient({ graphVersion: "v26.0" });
  return new MetaWhatsappDestinationService(client, gov, new MetaCreativesService(client, gov));
}

describe("MetaWhatsappDestinationService.resolve", () => {
  it("CTA de WhatsApp no criativo → meta_cta (autoritativo)", async () => {
    stubGraph({
      adIds: ["AD1"],
      creativeByAd: { AD1: { object_story_spec: { link_data: { call_to_action: { type: "WHATSAPP_MESSAGE", value: { link: "https://wa.me/5531953491166" } } } } } },
      campaignName: "[CLAUDE OPUS] TOP 6 — WHATS 95349-1166",
    });
    expect(await makeService().resolve(account, "CMP1")).toEqual({ number: "5531953491166", source: "meta_cta" });
  });

  it("sem CTA e sem página → cai no nome da campanha (campaign_name, pede confirmação)", async () => {
    stubGraph({
      adIds: ["AD1"],
      creativeByAd: { AD1: { object_story_spec: { page_id: "P1", link_data: { call_to_action: { type: "LEARN_MORE" } } } } },
      pageWhatsapp: "",
      campaignName: "[1398 CAPTACAO] TOP 6 — WHATS 95349-1166 — BH",
    });
    const dest = await makeService().resolve(account, "CMP1");
    expect(dest).toMatchObject({ number: "953491166", source: "campaign_name", entityName: expect.stringContaining("WHATS") });
  });

  it("página tem número conectado → meta_page (antes do nome)", async () => {
    stubGraph({
      adIds: ["AD1"],
      creativeByAd: { AD1: { object_story_spec: { page_id: "P1", link_data: { call_to_action: { type: "LEARN_MORE" } } } } },
      pageWhatsapp: "553133334444",
      campaignName: "[1398 CAPTACAO] — WHATS 95349-1166",
    });
    expect(await makeService().resolve(account, "CMP1")).toEqual({ number: "553133334444", source: "meta_page" });
  });

  it("nada resolvível → none", async () => {
    stubGraph({ adIds: ["AD1"], creativeByAd: { AD1: { object_story_spec: { link_data: {} } } }, campaignName: "Campanha sem telefone" });
    expect(await makeService().resolve(account, "CMP1")).toEqual({ number: null, source: "none" });
  });
});
