// Adapter local-fs do StoragePort (Fatia 7, MVP dev). Guarda o blob original de
// criativo no disco, content-addressed por sha256 (idempotente por conteúdo: o
// mesmo arquivo enviado 2x não duplica). Trocar por S3-compat (MinIO/bucket) =
// novo adapter atrás da mesma porta, sem tocar no core (§5). O blob NUNCA trafega
// na fila — grava aqui e passa a `ref` (§ StoragePort).

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import type { StoragePort, StoragePutInput, StoredAsset, StoredBlob } from "@trafego/shared/ports";

/** Config do adapter local (injetada pela composition a partir do env). */
export interface LocalStorageConfig {
  /** raiz no disco onde os blobs vivem. */
  readonly baseDir: string;
  /** base pública p/ compor o signedUrl (a api serve o arquivo em dev). */
  readonly urlBase: string;
}

/** Extensão default por content-type quando o chamador não informa `ext`. */
const EXT_BY_TYPE: Readonly<Record<string, string>> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
  "video/mp4": "mp4",
};

/** ref = `<keyPrefix>/<sha256>.<ext>` — determinística por conteúdo (idempotência). */
function refFor(input: StoragePutInput, digest: string): string {
  const ext = input.ext ?? EXT_BY_TYPE[input.contentType] ?? "bin";
  return `${input.keyPrefix.replace(/^\/+|\/+$/gu, "")}/${digest}.${ext}`;
}

/**
 * Cria o adapter local-fs. `ref` é o caminho relativo (opaco pro chamador); o
 * arquivo `.meta` irmão guarda o content-type p/ o `get` devolver fiel.
 */
export function createLocalStorage(config: LocalStorageConfig): StoragePort {
  const root = resolve(config.baseDir);

  // Resolve `ref` DENTRO da raiz e barra escape (`../`): o `ref` do `put` é seguro (sha256),
  // mas `get`/`signedUrl` aceitam `ref` externo — sem isso, o dia que uma rota servir blob
  // por `ref` viraria LFI (path traversal). Fora da raiz → lança (nunca lê fora).
  const absOf = (ref: string): string => {
    const abs = resolve(root, ref);
    if (abs !== root && !abs.startsWith(root + sep)) {
      throw new Error("storage: ref fora da raiz");
    }
    return abs;
  };

  return {
    async put(input: StoragePutInput): Promise<StoredAsset> {
      const digest = createHash("sha256").update(input.bytes).digest("hex");
      const ref = refFor(input, digest);
      const abs = absOf(ref);
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, input.bytes);
      await writeFile(`${abs}.type`, input.contentType, "utf8");
      return { ref, contentType: input.contentType, sizeBytes: input.bytes.byteLength };
    },

    async get(ref: string): Promise<StoredBlob | null> {
      try {
        const abs = absOf(ref);
        const bytes = await readFile(abs);
        const contentType = await readFile(`${abs}.type`, "utf8").catch(() => "application/octet-stream");
        const data = new Uint8Array(bytes);
        // etag = sha256 do conteúdo (content-addressed) — estável p/ Cache-Control/304 na rota de blob.
        const etag = createHash("sha256").update(data).digest("hex");
        return { bytes: data, contentType, etag };
      } catch {
        return null; // não existe → null (nunca crash)
      }
    },

    async signedUrl(ref: string): Promise<string> {
      // Local não assina — compõe base + ref (a api serve o arquivo em dev). Em prod
      // o adapter S3-compat devolve uma URL assinada de verdade com expiração.
      return `${config.urlBase.replace(/\/+$/u, "")}/${ref}`;
    },
  };
}
