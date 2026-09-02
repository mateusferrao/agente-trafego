/**
 * Borda de armazenamento de assets de criativo (Fatia 7). Guarda o blob original
 * (imagem/vídeo) que o usuário sobe (web) ou manda no WhatsApp, antes de subir pra
 * plataforma de ads. Adapter MVP = S3-compat (MinIO no dev, bucket em prod); trocar
 * provider = novo adapter, core intocado. O blob NUNCA trafega no payload da fila —
 * grava aqui e passa a `ref`.
 */
export interface StoragePutInput {
  /** conteúdo binário do asset. */
  readonly bytes: Uint8Array;
  /** MIME (ex: image/jpeg, video/mp4) — o adapter preserva p/ o get/signedUrl. */
  readonly contentType: string;
  /** namespace lógico (ex: `org/<id>/creatives`) — o adapter compõe a chave final. */
  readonly keyPrefix: string;
  /** extensão do arquivo (sem ponto) — ajuda o content-type no get. */
  readonly ext?: string;
}

export interface StoredAsset {
  /** referência opaca do asset no storage (o `get`/`signedUrl` recebe de volta). */
  readonly ref: string;
  readonly contentType: string;
  readonly sizeBytes: number;
}

export interface StoredBlob {
  readonly bytes: Uint8Array;
  readonly contentType: string;
  /** ETag/digest estável do conteúdo (content-addressed) — a rota de blob usa p/ `ETag`+304
   *  e `Cache-Control: immutable`. Local-fs = sha256 dos bytes; S3-compat = ETag do objeto. */
  readonly etag: string;
}

export interface StoragePort {
  /** Grava um blob e devolve a referência opaca (idempotente por conteúdo quando possível). */
  put(input: StoragePutInput): Promise<StoredAsset>;
  /** Lê o blob por referência (ex: p/ subir pra Meta). `null` se não existir. */
  get(ref: string): Promise<StoredBlob | null>;
  /** Remove o blob por referência. IDEMPOTENTE (não-existe = no-op, nunca lança por ausência). */
  delete(ref: string): Promise<void>;
  /** URL temporária de leitura (preview no site) — expira em `expiresSec`. */
  signedUrl(ref: string, expiresSec: number): Promise<string>;
}
