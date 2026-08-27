// Adapter S3-compat do StoragePort (Fatia 7, prod). Guarda o blob original de criativo num
// bucket S3-compatível (MinIO no EasyPanel, ou R2/B2/AWS externo), content-addressed por
// sha256 (mesma idempotência do local-fs: mesmo conteúdo → mesma chave → sobrescreve). Trocar
// de driver = env `STORAGE_DRIVER` (composition), core/casca/ingest intocados (§5). Bucket
// PRIVADO — o serving é a rota autenticada da api (não signedUrl), então `signedUrl` fica stub.

import { createHash } from "node:crypto";
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import type { StoragePort, StoragePutInput, StoredAsset, StoredBlob } from "@trafego/shared/ports";

/** Config do adapter S3-compat (injetada pela composition a partir do env). */
export interface S3StorageConfig {
  /** endpoint do provider (ex: http://minio:9000). Omitir → AWS S3 padrão da região. */
  readonly endpoint?: string;
  readonly region: string;
  readonly bucket: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  /** MinIO/muitos S3-compat exigem path-style (bucket no path, não no host). */
  readonly forcePathStyle: boolean;
}

/** Extensão default por content-type quando o chamador não informa `ext` (espelha o local-fs). */
const EXT_BY_TYPE: Readonly<Record<string, string>> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
  "video/mp4": "mp4",
  "video/quicktime": "mov",
};

/** key = `<keyPrefix>/<sha256>.<ext>` — content-addressed (idempotência por conteúdo). */
function keyFor(input: StoragePutInput, digest: string): string {
  const ext = input.ext ?? EXT_BY_TYPE[input.contentType] ?? "bin";
  return `${input.keyPrefix.replace(/^\/+|\/+$/gu, "")}/${digest}.${ext}`;
}

/** Cria o adapter S3-compat. `ref` = a chave do objeto (opaca pro chamador). */
export function createS3Storage(config: S3StorageConfig): StoragePort {
  const client = new S3Client({
    region: config.region,
    forcePathStyle: config.forcePathStyle,
    credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
    ...(config.endpoint ? { endpoint: config.endpoint } : {}),
  });

  return {
    async put(input: StoragePutInput): Promise<StoredAsset> {
      const digest = createHash("sha256").update(input.bytes).digest("hex");
      const ref = keyFor(input, digest);
      await client.send(
        new PutObjectCommand({
          Bucket: config.bucket,
          Key: ref,
          Body: input.bytes,
          ContentType: input.contentType,
        }),
      );
      return { ref, contentType: input.contentType, sizeBytes: input.bytes.byteLength };
    },

    async get(ref: string): Promise<StoredBlob | null> {
      try {
        const res = await client.send(new GetObjectCommand({ Bucket: config.bucket, Key: ref }));
        if (!res.Body) return null;
        const bytes = await res.Body.transformToByteArray();
        // etag = sha256 do conteúdo (uniforme com o local-fs; o mesmo asset dá o mesmo etag
        // em qualquer driver → 304 estável mesmo trocando de storage).
        const etag = createHash("sha256").update(bytes).digest("hex");
        return { bytes, contentType: res.ContentType ?? "application/octet-stream", etag };
      } catch {
        return null; // não existe / erro → null (a rota devolve 404; nunca crash)
      }
    },

    async signedUrl(): Promise<string> {
      // Serving é a rota autenticada da api (bucket privado) — signedUrl não é usado. Liga
      // (getSignedUrl real) quando houver consumidor (fast-follow registrado no ROADMAP).
      throw new Error("storage-s3: signedUrl não implementado (serving = rota autenticada, bucket privado)");
    },
  };
}
