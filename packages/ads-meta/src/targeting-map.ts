// Mapeamento NEUTRO → cru da Meta do público EXPLÍCITO (primitivos). PURO e testável.
// Fonte ÚNICA da tradução `TargetingSpec.explicit` → `targeting` da Graph API — reusada
// por `creation.ts` (createAdSet/deliveryEstimate) E por `mutations.ts` (adjust_audience,
// Fatia C). O vocabulário Meta (`geo_locations`/`flexible_spec`/`custom_locations`/
// `targeting_automation`) vive SÓ aqui — o core/shared falam `TargetingSpec`.

import type { TargetingSpec } from "@trafego/shared/types";

/** País default do targeting quando o `explicit` sai sem geo (a Meta rejeita `geo_locations`
 *  vazio: "Falta uma localização"). Beta = Brasil; geo derivado da conta = fast-follow. */
export const DEFAULT_TARGETING_GEO_COUNTRY = "BR";

/** Variante explícita do targeting neutro (público por primitivos). */
export type ExplicitTargeting = Extract<TargetingSpec, { kind: "explicit" }>;

/**
 * Público EXPLÍCITO por primitivos (geo+raio/idade/gênero/grupos de interesse/behavior/
 * públicos salvos) → `targeting` cru da Meta. Expansão SEMPRE fechada (público escolhido
 * pelo dono, sem ambiguidade de "fonte não decidiu" — diferente de `reuse_adset`).
 */
export function explicitTargetingToRaw(spec: ExplicitTargeting): Record<string, unknown> {
  // geo_locations montado direto (não via geoToRaw) p/ carregar RAIO por cidade/região +
  // custom_locations (raio em torno de endereço). `address_string` = a Meta geocodifica.
  const geoLocations: Record<string, unknown> = {};
  const countries = spec.geo.filter((g) => g.kind === "country").map((g) => g.key);
  const regions = spec.geo.filter((g) => g.kind === "region");
  const cities = spec.geo.filter((g) => g.kind === "city");
  // RAIO é city-only na Meta (regions/countries só aceitam `{key}`/ISO). Strip defensivo: mesmo
  // que um radius chegue numa region (input do site), NUNCA emitir radius fora de `cities`.
  const withRadius = (g: { key: string; radius?: number; distanceUnit?: "mile" | "kilometer" }) =>
    g.radius ? { key: g.key, radius: g.radius, distance_unit: g.distanceUnit ?? "kilometer" } : { key: g.key };
  if (countries.length) geoLocations["countries"] = countries;
  if (regions.length) geoLocations["regions"] = regions.map((g) => ({ key: g.key }));
  if (cities.length) geoLocations["cities"] = cities.map(withRadius);
  if (spec.radiusAreas && spec.radiusAreas.length > 0) {
    geoLocations["custom_locations"] = spec.radiusAreas.map((a) => ({ address_string: a.address, radius: a.radius, distance_unit: a.distanceUnit }));
  }
  // geo_locations NUNCA pode sair vazio (a Meta rejeita "Falta uma localização") — fallback país.
  if (Object.keys(geoLocations).length === 0) geoLocations["countries"] = [DEFAULT_TARGETING_GEO_COUNTRY];

  // interesses/behaviors em GRUPOS: flexible_spec = 1 objeto por grupo → OR dentro do grupo, AND
  // entre grupos (narrowing). Exclusão de interesse/behavior NÃO existe mais na Meta (só inclusão).
  const iGroups = (spec.interestGroups ?? []).filter((g) => g.length > 0).map((g) => ({ interests: g.map((i) => ({ id: i.id })) }));
  const bGroups = (spec.behaviorGroups ?? []).filter((g) => g.length > 0).map((g) => ({ behaviors: g.map((b) => ({ id: b.id })) }));
  const flexible_spec = [...iGroups, ...bGroups];

  return {
    geo_locations: geoLocations,
    ...(spec.ageMin !== undefined ? { age_min: spec.ageMin } : {}),
    ...(spec.ageMax !== undefined ? { age_max: spec.ageMax } : {}),
    ...(spec.genders && spec.genders.length > 0 ? { genders: spec.genders } : {}),
    ...(spec.customAudienceIncludeIds && spec.customAudienceIncludeIds.length > 0 ? { custom_audiences: spec.customAudienceIncludeIds.map((id) => ({ id })) } : {}),
    ...(spec.customAudienceExcludeIds && spec.customAudienceExcludeIds.length > 0 ? { excluded_custom_audiences: spec.customAudienceExcludeIds.map((id) => ({ id })) } : {}),
    ...(flexible_spec.length > 0 ? { flexible_spec } : {}),
    targeting_automation: { advantage_audience: 0 },
    targeting_relaxation_types: { custom_audience: 0, lookalike: 0 },
  };
}
