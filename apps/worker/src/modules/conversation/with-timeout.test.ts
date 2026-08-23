import { describe, expect, it } from "vitest";
import { TimeoutError, withTimeout } from "./with-timeout.js";

describe("withTimeout", () => {
  it("resolve normalmente quando a promise termina antes do teto", async () => {
    const p = new Promise<string>((resolve) => setTimeout(() => resolve("ok"), 5));
    await expect(withTimeout(p, 200)).resolves.toBe("ok");
  });

  it("propaga a rejeição original quando ela vem antes do teto", async () => {
    const p = new Promise<string>((_resolve, reject) => setTimeout(() => reject(new Error("falhou")), 5));
    await expect(withTimeout(p, 200)).rejects.toThrow("falhou");
  });

  it("rejeita com TimeoutError quando a promise nunca resolve/rejeita (travada)", async () => {
    const stuck = new Promise<string>(() => {}); // nunca resolve — simula fetch preso
    await expect(withTimeout(stuck, 5)).rejects.toBeInstanceOf(TimeoutError);
  });
});
