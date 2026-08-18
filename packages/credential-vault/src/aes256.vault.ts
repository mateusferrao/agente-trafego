import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { CredentialVaultPort } from "@trafego/shared/ports";
import type { EncryptedPayload } from "@trafego/shared/types";

/**
 * Envelope AES-256-GCM para o System User token (joia da coroa — CLAUDE §12).
 * IV aleatório por operação; tag GCM garante integridade. `keyVersion` viaja no
 * envelope p/ rotação futura. Nunca logar plaintext.
 */
const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12; // recomendado p/ GCM
const TAG_BYTES = 16;
const KEY_BYTES = 32; // AES-256

export class Aes256CredentialVault implements CredentialVaultPort {
  private readonly key: Buffer;
  private readonly keyVersion: number;

  /** `masterKeyBase64` = CREDENTIAL_MASTER_KEY (32 bytes em base64). */
  constructor(masterKeyBase64: string, keyVersion: number) {
    const key = Buffer.from(masterKeyBase64, "base64");
    if (key.length !== KEY_BYTES) {
      throw new Error(
        `CREDENTIAL_MASTER_KEY deve ter ${KEY_BYTES} bytes (base64); recebido ${key.length}.`,
      );
    }
    this.key = key;
    this.keyVersion = keyVersion;
  }

  encrypt(plaintext: string): EncryptedPayload {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGORITHM, this.key, iv, { authTagLength: TAG_BYTES });
    const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return {
      ciphertext: ciphertext.toString("base64"),
      iv: iv.toString("base64"),
      tag: tag.toString("base64"),
      keyVersion: this.keyVersion,
    };
  }

  decrypt(payload: EncryptedPayload): string {
    const iv = Buffer.from(payload.iv, "base64");
    const tag = Buffer.from(payload.tag, "base64");
    const ciphertext = Buffer.from(payload.ciphertext, "base64");
    const decipher = createDecipheriv(ALGORITHM, this.key, iv, { authTagLength: TAG_BYTES });
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  }
}
