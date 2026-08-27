import { beforeEach, describe, expect, it, vi } from "vitest";

/** Comandos enviados ao S3Client (capturados p/ inspeção). */
const sent: Array<{ kind: string; input: Record<string, unknown> }> = [];
let getBody: Uint8Array | null = new Uint8Array([1, 2, 3, 4]);

vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: class {
    send = vi.fn(async (cmd: { kind: string; input: Record<string, unknown> }) => {
      sent.push(cmd);
      if (cmd.kind === "get") {
        if (getBody === null) throw new Error("NoSuchKey");
        return { Body: { transformToByteArray: async () => getBody }, ContentType: "image/png" };
      }
      return {};
    });
  },
  PutObjectCommand: class {
    kind = "put";
    constructor(public input: Record<string, unknown>) {}
  },
  GetObjectCommand: class {
    kind = "get";
    constructor(public input: Record<string, unknown>) {}
  },
}));

const { createS3Storage } = await import("./index.js");

const config = {
  endpoint: "http://minio:9000",
  region: "us-east-1",
  bucket: "creatives",
  accessKeyId: "k",
  secretAccessKey: "s",
  forcePathStyle: true,
};

beforeEach(() => {
  sent.length = 0;
  getBody = new Uint8Array([1, 2, 3, 4]);
});

describe("createS3Storage", () => {
  it("put: chave content-addressed (sha256) + PutObject no bucket com content-type", async () => {
    const s = createS3Storage(config);
    const stored = await s.put({ bytes: new Uint8Array([1, 2, 3, 4]), contentType: "image/png", keyPrefix: "org/o1/creatives" });
    expect(stored.sizeBytes).toBe(4);
    expect(stored.ref).toMatch(/^org\/o1\/creatives\/[0-9a-f]{64}\.png$/u);
    const put = sent.find((c) => c.kind === "put")!;
    expect(put.input).toMatchObject({ Bucket: "creatives", Key: stored.ref, ContentType: "image/png" });
  });

  it("content-addressed: mesmo conteúdo → mesma ref (idempotente)", async () => {
    const s = createS3Storage(config);
    const a = await s.put({ bytes: new Uint8Array([9, 9]), contentType: "image/jpeg", keyPrefix: "org/o1/creatives" });
    const b = await s.put({ bytes: new Uint8Array([9, 9]), contentType: "image/jpeg", keyPrefix: "org/o1/creatives" });
    expect(a.ref).toBe(b.ref);
  });

  it("get: devolve bytes + contentType + etag sha256 (uniforme com o local-fs)", async () => {
    const s = createS3Storage(config);
    const blob = await s.get("org/o1/creatives/x.png");
    expect(Array.from(blob?.bytes ?? [])).toEqual([1, 2, 3, 4]);
    expect(blob?.contentType).toBe("image/png");
    expect(blob?.etag).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("get de chave inexistente → null (nunca crash)", async () => {
    getBody = null;
    const s = createS3Storage(config);
    expect(await s.get("org/o1/creatives/missing.png")).toBeNull();
  });

  it("signedUrl → lança (stub — serving é a rota autenticada, bucket privado)", async () => {
    const s = createS3Storage(config);
    await expect(s.signedUrl("ref", 60)).rejects.toThrow(/não implementado/u);
  });
});
