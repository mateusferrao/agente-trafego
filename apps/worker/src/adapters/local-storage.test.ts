import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLocalStorage } from "./local-storage.js";

describe("createLocalStorage", () => {
  let dir: string;
  const urlBase = "http://localhost:3333/assets";

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "trafego-storage-"));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("put→get devolve os mesmos bytes + content-type", async () => {
    const s = createLocalStorage({ baseDir: dir, urlBase });
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const stored = await s.put({ bytes, contentType: "image/png", keyPrefix: "org/o1/creatives" });
    expect(stored.sizeBytes).toBe(4);
    expect(stored.ref).toMatch(/^org\/o1\/creatives\/[0-9a-f]{64}\.png$/u);

    const blob = await s.get(stored.ref);
    expect(blob?.contentType).toBe("image/png");
    expect(Array.from(blob?.bytes ?? [])).toEqual([1, 2, 3, 4]);
  });

  it("content-addressed: mesmo conteúdo → mesma ref (idempotente)", async () => {
    const s = createLocalStorage({ baseDir: dir, urlBase });
    const bytes = new Uint8Array([9, 9, 9]);
    const a = await s.put({ bytes, contentType: "image/jpeg", keyPrefix: "org/o1/creatives" });
    const b = await s.put({ bytes, contentType: "image/jpeg", keyPrefix: "org/o1/creatives" });
    expect(a.ref).toBe(b.ref);
  });

  it("get de ref inexistente → null (nunca crash)", async () => {
    const s = createLocalStorage({ baseDir: dir, urlBase });
    expect(await s.get("org/o1/creatives/deadbeef.png")).toBeNull();
  });

  it("signedUrl compõe base + ref", async () => {
    const s = createLocalStorage({ baseDir: dir, urlBase });
    expect(await s.signedUrl("org/o1/creatives/x.png", 60)).toBe(
      "http://localhost:3333/assets/org/o1/creatives/x.png",
    );
  });
});
