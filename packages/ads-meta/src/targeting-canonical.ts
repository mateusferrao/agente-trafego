/**
 * Canonicalização PURA do `targeting` cru da Meta p/ comparação estável (drift fino do revert
 * de `adjust_audience`, D4). A Meta pode devolver o MESMO público com chaves e itens de array
 * em ORDEM diferente entre leituras (ex: `countries: ["BR","US"]` vs `["US","BR"]`, ordem de
 * `interests`), então comparar o JSON cru daria falso-positivo de drift. Aqui ordenamos as
 * chaves de objeto (recursivo) e os itens de array por sua forma canônica → duas leituras do
 * mesmo público colapsam na MESMA string; uma edição real de público muda a string.
 *
 * Vocabulário Meta (shape do targeting) vive só no adapter — por isso mora aqui, não no core.
 */

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

function canonicalize(value: unknown): Json {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) {
    // ordena os itens pela forma canônica (arrays da Meta são conjuntos sem ordem semântica).
    return value
      .map(canonicalize)
      .sort((a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1));
  }
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const out: { [k: string]: Json } = {};
    for (const key of Object.keys(obj).sort()) {
      const v = canonicalize(obj[key]);
      // ignora chaves vazias/nulas p/ não distinguir "ausente" de "presente vazio".
      if (v === null) continue;
      if (Array.isArray(v) && v.length === 0) continue;
      if (typeof v === "object" && !Array.isArray(v) && Object.keys(v).length === 0) continue;
      out[key] = v;
    }
    return out;
  }
  if (typeof value === "boolean") return value;
  // a Graph API devolve o MESMO número ora como number (18), ora como string ("18") entre leituras
  // → coage os dois p/ string, senão a mesma audiência daria falso-positivo de drift.
  return String(value);
}

/**
 * String canônica estável de um `targeting` cru (ou null). Mesma entrada semântica → mesma saída;
 * comparar duas dessas detecta uma edição real de público sem falso-positivo por reordenação.
 */
export function canonicalizeTargeting(targeting: Readonly<Record<string, unknown>> | null | undefined): string {
  return JSON.stringify(canonicalize(targeting ?? {}));
}
