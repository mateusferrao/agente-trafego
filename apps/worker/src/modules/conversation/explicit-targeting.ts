// Montagem PURA do público EXPLÍCITO (primitivos JÁ resolvidos nome→id) → `TargetingSpec.explicit`.
// Fonte ÚNICA da montagem — reusada pela criação de campanha (`proposeCreateCampaign`) E pela edição
// de público (`adjust_audience`, Fatia C). Sem IO: a resolução nome→id (prepare*) fica no caller;
// aqui só o formato do `explicit` neutro (o vocabulário Meta vive no adapter `targeting-map`).

import type { TargetingSpec } from "@trafego/shared";

type ExplicitTargeting = Extract<TargetingSpec, { readonly kind: "explicit" }>;
type ExplicitGeo = ExplicitTargeting["geo"][number];
type RadiusArea = { readonly address: string; readonly radius: number; readonly distanceUnit: "kilometer" };

/** Geo default quando não há cidade NEM área por endereço (a Meta exige uma localização). Beta = BR. */
const DEFAULT_EXPLICIT_GEO: ExplicitGeo = { key: "BR", name: "Brasil", kind: "country" };

/** Partes já resolvidas (nome→id) que compõem o público explícito. */
export interface ExplicitTargetingParts {
  /** geo resolvido, já com raio de cidade aplicado (`applyCityRadius`). */
  readonly geo: readonly ExplicitGeo[];
  /** raio em torno de endereços (já clampado). */
  readonly radiusAreas?: readonly RadiusArea[];
  readonly ageMin?: number;
  readonly ageMax?: number;
  readonly gender?: "all" | "men" | "women";
  /** interesses resolvidos (id+nome) — 1 grupo OR. */
  readonly interests?: readonly { readonly id: string; readonly name: string }[];
  /** comportamentos resolvidos (id+nome) — 1 grupo OR. */
  readonly behaviors?: readonly { readonly id: string; readonly name: string }[];
  readonly includeAudienceIds?: readonly string[];
  readonly excludeAudienceIds?: readonly string[];
}

/** Há QUALQUER primitivo/público explícito? (senão não faz sentido montar `explicit` — cai no default). */
export function hasExplicitContent(p: ExplicitTargetingParts): boolean {
  return (
    p.geo.length > 0 ||
    (p.radiusAreas?.length ?? 0) > 0 ||
    p.ageMin !== undefined ||
    p.ageMax !== undefined ||
    (p.gender !== undefined && p.gender !== "all") ||
    (p.interests?.length ?? 0) > 0 ||
    (p.behaviors?.length ?? 0) > 0 ||
    (p.includeAudienceIds?.length ?? 0) > 0 ||
    (p.excludeAudienceIds?.length ?? 0) > 0
  );
}

/**
 * Monta o `explicit` TargetingSpec a partir das partes resolvidas. PURA. Espelha a montagem antes
 * inline em `proposeCreateCampaign` (geo+raio/idade/gênero/grupos de interesse+behavior/públicos):
 * geo default (BR) só quando NÃO há cidade NEM área por endereço (senão a Meta uniria BR ∪ raio,
 * ampliando o público). Expansão fechada é decidida no adapter (`explicitTargetingToRaw`).
 */
export function assembleExplicitTargeting(p: ExplicitTargetingParts): ExplicitTargeting {
  const hasAreas = (p.radiusAreas?.length ?? 0) > 0;
  const geoBase = p.geo.length > 0 ? p.geo : hasAreas ? [] : [DEFAULT_EXPLICIT_GEO];
  const hasAudience = (p.includeAudienceIds?.length ?? 0) > 0 || (p.excludeAudienceIds?.length ?? 0) > 0;
  return {
    kind: "explicit",
    geo: geoBase,
    ...(hasAreas ? { radiusAreas: p.radiusAreas } : {}),
    ...(p.ageMin !== undefined ? { ageMin: p.ageMin } : {}),
    ...(p.ageMax !== undefined ? { ageMax: p.ageMax } : {}),
    ...(p.gender === "men" ? { genders: [1] } : p.gender === "women" ? { genders: [2] } : {}),
    ...(p.interests && p.interests.length > 0 ? { interestGroups: [p.interests] } : {}),
    ...(p.behaviors && p.behaviors.length > 0 ? { behaviorGroups: [p.behaviors] } : {}),
    ...(hasAudience ? { customAudienceIncludeIds: p.includeAudienceIds ?? [], customAudienceExcludeIds: p.excludeAudienceIds ?? [] } : {}),
  };
}
