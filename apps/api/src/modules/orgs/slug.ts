import { randomBytes } from "node:crypto";

/** Sufixo aleatório (hex) anexado ao slug p/ garantir unicidade sem round-trip. */
const SLUG_SUFFIX_BYTES = 3; // 6 chars hex

/** Faixa de diacríticos combinantes (Unicode) removida após NFD. */
const COMBINING_MARKS = /[̀-ͯ]/g;

/**
 * Normaliza um nome livre em um slug base: minúsculo, sem acento, `-` no lugar
 * de não-alfanuméricos, sem `-` nas pontas. Função pura.
 */
export function slugify(name: string): string {
  return name
    .normalize("NFD")
    .replace(COMBINING_MARKS, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Slug de org derivado do nome + sufixo aleatório curto. A coluna `orgs.slug` é
 * `unique`; o sufixo torna colisão desprezível (o constraint é a rede final).
 * Nome sem caractere aproveitável cai em `org` como base.
 */
export function orgSlug(name: string): string {
  const base = slugify(name) || "org";
  return `${base}-${randomBytes(SLUG_SUFFIX_BYTES).toString("hex")}`;
}
