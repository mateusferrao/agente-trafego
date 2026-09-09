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
  adsetPromotedWhatsapp?: string;
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
      if (url.includes("/adsets"))
        return json({ data: opts.adsetPromotedWhatsapp ? [{ promoted_object: { whatsapp_phone_number: opts.adsetPromotedWhatsapp } }] : [] });
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
  it("CTWA: número no promoted_object do conjunto → meta_promoted_object (1º tier, autoritativo)", async () => {
    // caso REAL (prod): CTA vem genérico (api.whatsapp.com/send, sem número) e a página não expõe
    // whatsapp_number — o destino está em adset.promoted_object.whatsapp_phone_number.
    stubGraph({
      adIds: ["AD1"],
      adsetPromotedWhatsapp: "5531953491398",
      creativeByAd: { AD1: { object_story_spec: { video_data: { call_to_action: { type: "WHATSAPP_MESSAGE", value: { link: "https://api.whatsapp.com/send" } } } } } },
      campaignName: "[1398 CAPTACAO] ESCALA - BH home-only",
    });
    expect(await makeService().resolve(account, "CMP1")).toEqual({ number: "5531953491398", source: "meta_promoted_object" });
  });

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

/** Roteia o fetch por alvo: (a) leitura direta do nó da Página (`/{pageId}?fields=name,whatsapp_number`)
 *  e (b) páginas do NEGÓCIO da conta (`/act_{id}?fields=business{owned_pages,client_pages}`). "fail" = 403. */
function stubPagesGraph(opts: {
  direct?: { name?: string; whatsapp_number?: string } | "fail";
  business?: { owned?: Array<{ id?: string; name?: string }>; client?: Array<{ id?: string; name?: string }> } | "fail";
}): void {
  const fail = () => new Response(JSON.stringify({ error: { message: "no permission" } }), { status: 403, headers: { "content-type": "application/json" } });
  const ok = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { "content-type": "application/json" } });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("business")) {
        if (opts.business === "fail") return fail();
        const b = opts.business ?? {};
        return ok({ business: { owned_pages: { data: b.owned ?? [] }, client_pages: { data: b.client ?? [] } } });
      }
      // leitura direta do nó da Página
      if (opts.direct === undefined || opts.direct === "fail") return fail();
      return ok(opts.direct);
    }),
  );
}

describe("MetaWhatsappDestinationService.pageInfo (destino no rascunho)", () => {
  it("nó direto tem nome + número → usa o nó (não precisa do negócio)", async () => {
    stubPagesGraph({ direct: { name: "CaquiAI Oficial", whatsapp_number: "+55 (31) 3333-4444" } });
    expect(await makeService().pageInfo(account, "P1")).toEqual({ pageId: "P1", name: "CaquiAI Oficial", whatsappNumber: "553133334444" });
  });

  it("nó direto 403 → NOME vem das páginas do NEGÓCIO (fallback confiável, item 1)", async () => {
    stubPagesGraph({ direct: "fail", business: { owned: [{ id: "P1", name: "CaquiAI Oficial" }] } });
    expect(await makeService().pageInfo(account, "P1")).toEqual({ pageId: "P1", name: "CaquiAI Oficial" });
  });

  it("nó direto tem número mas SEM nome → mantém o número e pega o nome no negócio", async () => {
    stubPagesGraph({ direct: { whatsapp_number: "+553133334444" }, business: { client: [{ id: "P1", name: "CaquiAI Oficial" }] } });
    expect(await makeService().pageInfo(account, "P1")).toEqual({ pageId: "P1", name: "CaquiAI Oficial", whatsappNumber: "553133334444" });
  });

  it("nó direto 403 E negócio vazio → só { pageId } (degrada honesto, nunca quebra)", async () => {
    stubPagesGraph({ direct: "fail", business: { owned: [], client: [] } });
    expect(await makeService().pageInfo(account, "P1")).toEqual({ pageId: "P1" });
  });
});

describe("MetaWhatsappDestinationService.listAccountPages (páginas do negócio — escolher entre N)", () => {
  it("funde owned + client, dedupe por id, sem id é dropado (owned vence o dup)", async () => {
    stubPagesGraph({
      business: {
        owned: [{ id: "P1", name: "CaquiAI Oficial" }, { name: "sem id — ignorada" }],
        client: [{ id: "P2", name: "CaquiAI Loja" }, { id: "P1", name: "dup ignorado" }],
      },
    });
    expect(await makeService().listAccountPages(account)).toEqual([
      { pageId: "P1", name: "CaquiAI Oficial" },
      { pageId: "P2", name: "CaquiAI Loja" },
    ]);
  });

  it("403/sem acesso → lista vazia (o caller degrada honesto)", async () => {
    stubPagesGraph({ business: "fail" });
    expect(await makeService().listAccountPages(account)).toEqual([]);
  });

  it("conta sem negócio → lista vazia", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({}), { status: 200, headers: { "content-type": "application/json" } })));
    expect(await makeService().listAccountPages(account)).toEqual([]);
  });
});
