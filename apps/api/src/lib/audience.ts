// Conversões de público EXPLÍCITO compartilhadas na API (drafts + approvals): input do editor do
// site (`ExplicitAudienceInput`, já resolvido keys/ids) ↔ `TargetingSpec.explicit` neutro ↔ view de
// saída pro card. Fonte única — o mesmo editor (`GeoAudienceEditor`) edita público de rascunho E de
// ação `adjust_audience` (Fatia C). Puro (raio clampado via `clampRadius` do core).

import { clampRadius } from "@trafego/core";
import type { TargetingSpec } from "@trafego/shared/types";
import type { ExplicitAudienceInput } from "../modules/drafts/schema.js";

type ExplicitTargeting = Extract<TargetingSpec, { kind: "explicit" }>;

/** Input do editor do site (keys/ids já resolvidos) → `explicit` neutro. Raio clampado (city/endereço). */
export function buildExplicitFromInput(a: ExplicitAudienceInput): ExplicitTargeting {
  const geo = a.geo.map((g) => {
    if (g.kind !== "city" || g.radius == null) return { key: g.key, name: g.name, kind: g.kind };
    const { radius } = clampRadius(g.radius, g.distanceUnit ?? "kilometer", "city");
    return { key: g.key, name: g.name, kind: g.kind, radius, distanceUnit: g.distanceUnit ?? ("kilometer" as const) };
  });
  const radiusAreas = (a.radiusAreas ?? []).map((r) => {
    const { radius } = clampRadius(r.radius, r.distanceUnit, "address");
    return { address: r.address, radius, distanceUnit: r.distanceUnit };
  });
  return {
    kind: "explicit",
    geo,
    ...(radiusAreas.length > 0 ? { radiusAreas } : {}),
    ...(a.ageMin != null ? { ageMin: a.ageMin } : {}),
    ...(a.ageMax != null ? { ageMax: a.ageMax } : {}),
    ...(a.genders && a.genders.length > 0 ? { genders: a.genders } : {}),
    ...(a.interestGroups && a.interestGroups.length > 0 ? { interestGroups: a.interestGroups } : {}),
    ...(a.behaviorGroups && a.behaviorGroups.length > 0 ? { behaviorGroups: a.behaviorGroups } : {}),
    ...(a.customAudienceIncludeIds && a.customAudienceIncludeIds.length > 0 ? { customAudienceIncludeIds: a.customAudienceIncludeIds } : {}),
    ...(a.customAudienceExcludeIds && a.customAudienceExcludeIds.length > 0 ? { customAudienceExcludeIds: a.customAudienceExcludeIds } : {}),
  };
}

/** View de saída do público explícito (semente do editor no card) — normaliza opcionais em `null`.
 *  Mutável de propósito (casa com o tipo inferido do zod de saída dos schemas). */
export interface ExplicitAudienceView {
  geo: { key: string; name: string; kind: "country" | "region" | "city"; radius: number | null; distanceUnit: "mile" | "kilometer" | null }[];
  radiusAreas: { address: string; radius: number; distanceUnit: "mile" | "kilometer" }[];
  ageMin: number | null;
  ageMax: number | null;
  genders: (1 | 2)[] | null;
  interestGroups: { id: string; name: string }[][];
  behaviorGroups: { id: string; name: string }[][];
  customAudienceIncludeIds: string[];
  customAudienceExcludeIds: string[];
}

/** `explicit` neutro → view de saída (semente do editor do site). */
export function serializeExplicitAudience(t: ExplicitTargeting): ExplicitAudienceView {
  return {
    geo: t.geo.map((g) => ({ key: g.key, name: g.name, kind: g.kind, radius: g.radius ?? null, distanceUnit: g.distanceUnit ?? null })),
    radiusAreas: (t.radiusAreas ?? []).map((a) => ({ address: a.address, radius: a.radius, distanceUnit: a.distanceUnit })),
    ageMin: t.ageMin ?? null,
    ageMax: t.ageMax ?? null,
    genders: t.genders ? [...t.genders] : null,
    interestGroups: (t.interestGroups ?? []).map((grp) => grp.map((i) => ({ id: i.id, name: i.name }))),
    behaviorGroups: (t.behaviorGroups ?? []).map((grp) => grp.map((b) => ({ id: b.id, name: b.name }))),
    customAudienceIncludeIds: [...(t.customAudienceIncludeIds ?? [])],
    customAudienceExcludeIds: [...(t.customAudienceExcludeIds ?? [])],
  };
}
