import { describe, expect, it, vi } from "vitest";
import type { Redis } from "ioredis";
import { takePendingMedia } from "./pending-media.js";

describe("takePendingMedia (consome a imagem anexada por UM turno: get + del)", () => {
  it("lê e REMOVE a mídia (del chamado)", async () => {
    const del = vi.fn(async () => 1);
    const redis = { get: async () => JSON.stringify({ dataUrl: "data:image/png;base64,ZZ", mimetype: "image/png" }), del } as unknown as Redis;
    const media = await takePendingMedia(redis, "cv-1");
    expect(media?.dataUrl).toContain("base64,ZZ");
    expect(del).toHaveBeenCalledOnce();
  });

  it("ausente → null (turno de texto normal)", async () => {
    const redis = { get: async () => null, del: vi.fn() } as unknown as Redis;
    expect(await takePendingMedia(redis, "cv-1")).toBeNull();
  });

  it("json inválido → null (nunca quebra o turno)", async () => {
    const redis = { get: async () => "{quebrado", del: vi.fn(async () => 1) } as unknown as Redis;
    expect(await takePendingMedia(redis, "cv-1")).toBeNull();
  });
});
