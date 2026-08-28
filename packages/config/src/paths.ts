import { existsSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Marcador da raiz do monorepo (o único arquivo garantido só na raiz). */
const WORKSPACE_MARKER = "pnpm-workspace.yaml";

let cachedRoot: string | null = null;

/**
 * Raiz do monorepo — resolvida a partir da LOCALIZAÇÃO deste módulo (estável), NÃO de
 * `process.cwd()` (que varia: a api roda de `apps/api`, o worker de `apps/worker`, scripts
 * da raiz). Sobe os diretórios até achar o `pnpm-workspace.yaml`. Fallback = cwd (dev solto).
 */
export function repoRoot(): string {
  if (cachedRoot) return cachedRoot;
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 10; i++) {
    if (existsSync(join(dir, WORKSPACE_MARKER))) {
      cachedRoot = dir;
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  cachedRoot = process.cwd();
  return cachedRoot;
}

/**
 * Resolve um diretório de DADOS (ex: storage local de criativos) a um caminho ABSOLUTO
 * ancorado na raiz do monorepo — assim api e worker (que rodam de cwds diferentes) apontam
 * pro MESMO lugar. Sem isso, o `./.data` relativo vira `apps/api/.data` × `apps/worker/.data`
 * e a api não acha o blob que o worker gravou (thumb 404). Caminho já absoluto passa direto.
 */
export function resolveDataDir(dir: string): string {
  return isAbsolute(dir) ? dir : resolve(repoRoot(), dir);
}
