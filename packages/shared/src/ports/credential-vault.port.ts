import type { EncryptedPayload } from "../types/index.js";

/**
 * Envelope AES-256-GCM p/ o System User token (joia da coroa).
 * keyVersion permite rotação de chave. Nunca logar plaintext.
 */
export interface CredentialVaultPort {
  encrypt(plaintext: string): EncryptedPayload;
  decrypt(payload: EncryptedPayload): string;
}
