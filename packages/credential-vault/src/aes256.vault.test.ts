import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { Aes256CredentialVault } from "./aes256.vault.js";

/** Chave mestra válida (32 bytes) em base64, como vem de CREDENTIAL_MASTER_KEY. */
function validKeyBase64(): string {
  return randomBytes(32).toString("base64");
}

const KEY_VERSION = 1;

describe("Aes256CredentialVault", () => {
  it("round-trip: decrypt devolve o plaintext original", () => {
    const vault = new Aes256CredentialVault(validKeyBase64(), KEY_VERSION);
    const secret = "EAAB-system-user-token-1234567890";

    const payload = vault.encrypt(secret);

    expect(vault.decrypt(payload)).toBe(secret);
  });

  it("marca a keyVersion no envelope", () => {
    const vault = new Aes256CredentialVault(validKeyBase64(), 7);
    expect(vault.encrypt("x").keyVersion).toBe(7);
  });

  it("gera IV/ciphertext diferentes a cada encrypt (IV aleatório)", () => {
    const vault = new Aes256CredentialVault(validKeyBase64(), KEY_VERSION);
    const a = vault.encrypt("mesmo-segredo");
    const b = vault.encrypt("mesmo-segredo");

    expect(a.iv).not.toBe(b.iv);
    expect(a.ciphertext).not.toBe(b.ciphertext);
  });

  it("falha ao decriptar com chave diferente", () => {
    const enc = new Aes256CredentialVault(validKeyBase64(), KEY_VERSION);
    const other = new Aes256CredentialVault(validKeyBase64(), KEY_VERSION);
    const payload = enc.encrypt("segredo");

    expect(() => other.decrypt(payload)).toThrow();
  });

  it("falha ao decriptar com tag adulterada (integridade GCM)", () => {
    const vault = new Aes256CredentialVault(validKeyBase64(), KEY_VERSION);
    const payload = vault.encrypt("segredo");
    const tampered = { ...payload, tag: Buffer.from("0".repeat(16)).toString("base64") };

    expect(() => vault.decrypt(tampered)).toThrow();
  });

  it("rejeita chave mestra com tamanho inválido (≠ 32 bytes)", () => {
    const shortKey = randomBytes(16).toString("base64");
    expect(() => new Aes256CredentialVault(shortKey, KEY_VERSION)).toThrow();
  });
});
