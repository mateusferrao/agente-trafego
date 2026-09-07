/**
 * Detecção de drift de PÚBLICO p/ o revert de `adjust_audience` (D4), robusta à normalização da
 * Meta. Problema: o baseline do drift é o `targeting` que NÓS escrevemos (o spec cru do público
 * novo), mas a Meta ENRIQUECE o que devolve no GET (`location_types`, `targeting_automation`,
 * expansões de geo, `name` nos interesses, `age_max` implícito, etc.). Comparar por igualdade
 * daria falso-positivo de drift em quase todo revert honesto (bloquearia sem ninguém ter mexido).
 *
 * Solução: comparar por CONTENÇÃO estrutural — o público que escrevemos precisa continuar CONTIDO
 * no público atual (todo campo que setamos casa com o que está no ar); campos que só a Meta injeta
 * são ignorados. Uma edição concorrente de uma dimensão que setamos (ex: trocar o país) quebra a
 * contenção → drift. Semântica de arrays = conjunto (ordem irrelevante) + número↔string coeridos
 * (a Graph devolve ora number ora string). Vocabulário Meta (shape do targeting) vive só no adapter.
 */

/** Leaf coerido: número e número-como-string colapsam (a Graph devolve os dois p/ o mesmo valor). */
function coerceLeaf(value: unknown): string | boolean {
  if (typeof value === "boolean") return value;
  return String(value);
}

/** Um valor "vazio" não exige nada do lado atual (não distingue ausente de presente-vazio). */
function isEmpty(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === "object") return Object.keys(value as Record<string, unknown>).length === 0;
  return false;
}

/** `sub` está estruturalmente CONTIDO em `sup`? (todo leaf de sub casa em sup; extras em sup ok) */
function contains(sup: unknown, sub: unknown): boolean {
  if (isEmpty(sub)) return true;
  if (Array.isArray(sub)) {
    if (!Array.isArray(sup)) return false;
    // conjunto: cada item de sub tem que casar com ALGUM item de sup (ordem irrelevante).
    return sub.every((el) => sup.some((cand) => contains(cand, el)));
  }
  if (typeof sub === "object" && sub !== null) {
    if (typeof sup !== "object" || sup === null || Array.isArray(sup)) return false;
    const supObj = sup as Record<string, unknown>;
    return Object.keys(sub as Record<string, unknown>).every((k) => {
      const sv = (sub as Record<string, unknown>)[k];
      return isEmpty(sv) || contains(supObj[k], sv);
    });
  }
  return coerceLeaf(sup) === coerceLeaf(sub);
}

/**
 * O público do adset mudou desde a edição? `current` = targeting cru ATUAL (read-back da Meta);
 * `applied` = o targeting que a edição deixou (o spec que escrevemos). Retorna `true` quando algo
 * que ESCREVEMOS não está mais no ar (edição concorrente) → o revert deve barrar por drift.
 */
export function targetingChanged(
  current: Readonly<Record<string, unknown>> | null | undefined,
  applied: Readonly<Record<string, unknown>> | null | undefined,
): boolean {
  return !contains(current ?? {}, applied ?? {});
}
