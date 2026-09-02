import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { describe, expect, it } from "vitest";
import { repoRoot, resolveDataDir } from "./paths.js";

describe("resolveDataDir (storage local ancorado na raiz do monorepo)", () => {
  it("repoRoot aponta pra um diretório com o pnpm-workspace.yaml", () => {
    expect(existsSync(join(repoRoot(), "pnpm-workspace.yaml"))).toBe(true);
  });

  it("caminho relativo → absoluto ancorado na raiz (não no cwd)", () => {
    const resolved = resolveDataDir("./.data/creatives");
    expect(isAbsolute(resolved)).toBe(true);
    expect(resolved).toBe(join(repoRoot(), ".data/creatives"));
  });

  it("caminho já absoluto → passa direto (respeita override explícito)", () => {
    const abs = process.platform === "win32" ? "C:\\srv\\data" : "/srv/data";
    expect(resolveDataDir(abs)).toBe(abs);
  });
});
