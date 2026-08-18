import { describe, expect, it } from "vitest";
import { argon2Hasher } from "./password.js";

describe("argon2Hasher", () => {
  it("gera hash diferente da senha em claro", async () => {
    const h = await argon2Hasher.hash("s3nha-forte");
    expect(h).not.toBe("s3nha-forte");
    expect(h.startsWith("$argon2")).toBe(true);
  });

  it("verifica true para a senha correta", async () => {
    const h = await argon2Hasher.hash("s3nha-forte");
    await expect(argon2Hasher.verify(h, "s3nha-forte")).resolves.toBe(true);
  });

  it("verifica false para senha errada", async () => {
    const h = await argon2Hasher.hash("s3nha-forte");
    await expect(argon2Hasher.verify(h, "errada")).resolves.toBe(false);
  });

  it("verifica false (sem lançar) para hash malformado", async () => {
    await expect(argon2Hasher.verify("nao-e-hash", "x")).resolves.toBe(false);
  });
});
