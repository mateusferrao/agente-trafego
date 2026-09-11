import { afterEach, describe, expect, it, vi } from "vitest";
import { downloadAsDataUrl } from "./download.js";

const URL_OK = "https://scontent.xx.fbcdn.net/v/t15.5256-10/frame.jpg";

function imageResponse(bytes: Uint8Array, contentType = "image/jpeg", extraHeaders: Record<string, string> = {}): Response {
  return new Response(bytes, { status: 200, headers: { "content-type": contentType, ...extraHeaders } });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("downloadAsDataUrl", () => {
  it("baixa e devolve data URL base64 (bytes inline, não a URL crua)", async () => {
    const bytes = new Uint8Array([1, 2, 3, 4, 5]);
    vi.stubGlobal("fetch", vi.fn(async () => imageResponse(bytes)));
    const out = await downloadAsDataUrl(URL_OK);
    expect(out).toBe(`data:image/jpeg;base64,${Buffer.from(bytes).toString("base64")}`);
  });

  it("URL morta (410 Gone) → null (não quebra; o chamador degrada o frame)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 410 })));
    expect(await downloadAsDataUrl(URL_OK)).toBeNull();
  });

  it("erro de rede / timeout (fetch rejeita) → null, sem lançar", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("aborted");
    }));
    await expect(downloadAsDataUrl(URL_OK)).resolves.toBeNull();
  });

  it("content-type não-imagem → null (não ecoa tipo arbitrário inline)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => imageResponse(new Uint8Array([1]), "application/json")));
    expect(await downloadAsDataUrl(URL_OK)).toBeNull();
  });

  it("content-length acima do cap → null (não materializa payload gigante)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => imageResponse(new Uint8Array([1]), "image/jpeg", { "content-length": String(50 * 1024 * 1024) })));
    expect(await downloadAsDataUrl(URL_OK)).toBeNull();
  });

  it("content-type com parâmetro (image/jpeg; charset=binary) → data URL válida sem espaço no mediatype", async () => {
    const bytes = new Uint8Array([7, 8]);
    vi.stubGlobal("fetch", vi.fn(async () => imageResponse(bytes, "image/jpeg; charset=binary")));
    expect(await downloadAsDataUrl(URL_OK)).toBe(`data:image/jpeg;base64,${Buffer.from(bytes).toString("base64")}`);
  });
});
