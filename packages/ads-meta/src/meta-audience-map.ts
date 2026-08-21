import type { AudienceProfile, AudienceStage } from "@trafego/shared";

/**
 * Mapeamento **específico da Meta** do `targeting` do adset → `AudienceProfile`
 * neutro (§Bloco 2). Todo o vocabulário de segmentação da Meta vive AQUI, isolado
 * no adapter — o core/prompt/UI só falam o tipo neutro. Adicionar Google/TikTok =
 * outro mapa como este, sem tocar no core.
 *
 * Estágio SEM chamadas extras: distinguimos lookalike (frio) × custom audience de
 * retargeting (quente) pelo NOME do público (o targeting já traz `{id,name}`);
 * resolver o `subtype` de cada audience p/ precisão cirúrgica = fast-follow.
 */

/** Público nomeado como lookalike/semelhante = frio (prospecção), não é retargeting. */
const LOOKALIKE_HINTS = ["lookalike", "look-alike", "look alike", "lal ", "lal-", "lal_", "similar", "semelhante"];

/** Máx. de interesses resumidos (compacto — não despeja o firehose). */
const MAX_INTERESTS = 5;

interface RawAudienceRef {
  readonly id?: string;
  readonly name?: string;
}
interface RawInterestGroup {
  readonly interests?: readonly RawAudienceRef[];
  readonly behaviors?: readonly RawAudienceRef[];
}
/** Subconjunto do `targeting` cru da Meta que resumimos (o resto é ignorado de propósito). */
export interface RawTargeting {
  readonly geo_locations?: {
    readonly countries?: readonly string[];
    readonly regions?: readonly RawAudienceRef[];
    readonly cities?: readonly RawAudienceRef[];
  };
  readonly age_min?: number;
  readonly age_max?: number;
  readonly custom_audiences?: readonly RawAudienceRef[];
  readonly excluded_custom_audiences?: readonly RawAudienceRef[];
  readonly flexible_spec?: readonly RawInterestGroup[];
  readonly interests?: readonly RawAudienceRef[];
}

function isLookalikeName(name: string | undefined): boolean {
  if (!name) return false;
  const lower = name.toLowerCase();
  return LOOKALIKE_HINTS.some((hint) => lower.includes(hint));
}

/** Interesses/comportamentos resumidos (top-N nomes, dedupe, preserva ordem). */
function collectInterests(t: RawTargeting): string[] {
  const names: string[] = [];
  const push = (refs: readonly RawAudienceRef[] | undefined): void => {
    for (const r of refs ?? []) if (r.name) names.push(r.name);
  };
  for (const group of t.flexible_spec ?? []) {
    push(group.interests);
    push(group.behaviors);
  }
  push(t.interests);
  return [...new Set(names)].slice(0, MAX_INTERESTS);
}

function geoLabels(t: RawTargeting): string[] {
  const geo = t.geo_locations;
  if (!geo) return [];
  if (geo.countries && geo.countries.length > 0) return [...geo.countries];
  const regions = (geo.regions ?? []).map((r) => r.name).filter((n): n is string => !!n);
  const cities = (geo.cities ?? []).map((c) => c.name).filter((n): n is string => !!n);
  return [...regions, ...cities];
}

/**
 * Normaliza o `targeting` de UM adset. `undefined` quando não há sinal de
 * segmentação (nada a resumir). Estágio: `remarketing` se há ao menos um custom
 * audience de INCLUSÃO que NÃO é lookalike (público quente); senão `prospecting`
 * (amplo/interesses/só-lookalike). `unknown` fica reservado (hoje sempre decidível).
 */
export function audienceFromTargeting(t: RawTargeting | undefined): AudienceProfile | undefined {
  if (!t) return undefined;
  const inclusion = t.custom_audiences ?? [];
  const exclusions = t.excluded_custom_audiences ?? [];
  const geo = geoLabels(t);
  const interests = collectInterests(t);

  const hasSignal =
    inclusion.length > 0 ||
    exclusions.length > 0 ||
    geo.length > 0 ||
    t.age_min !== undefined ||
    t.age_max !== undefined ||
    interests.length > 0;
  if (!hasSignal) return undefined;

  const hasWarm = inclusion.some((a) => !isLookalikeName(a.name));
  const stage: AudienceStage = hasWarm ? "remarketing" : "prospecting";

  return {
    stage,
    customAudienceCount: inclusion.length,
    exclusionCount: exclusions.length,
    ...(geo.length > 0 ? { geo } : {}),
    ...(t.age_min !== undefined ? { ageMin: t.age_min } : {}),
    ...(t.age_max !== undefined ? { ageMax: t.age_max } : {}),
    ...(interests.length > 0 ? { interests } : {}),
  };
}
