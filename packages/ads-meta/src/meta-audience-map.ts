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
  /** id de geo (cidade/região) da Meta — `id` é usado por custom audiences, `key` por geo. */
  readonly key?: string;
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
  /** Advantage+ audience (expansão unificada, v23+; default 1 na CRIAÇÃO quando ausente — por
   *  isso "ausente" NUNCA deve ser copiado cru pra um targeting novo, ver `resolveExpansion`). */
  readonly targeting_automation?: { readonly advantage_audience?: 0 | 1 };
  /** Relaxamento por-dimensão (legado, ainda válido) — independente do `targeting_automation`. */
  readonly targeting_relaxation_types?: { readonly custom_audience?: 0 | 1; readonly lookalike?: 0 | 1 };
}

export function isLookalikeName(name: string | undefined): boolean {
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

/** Grupos de refs COM id (Slice 6 — cópia fiel). `pick` escolhe interests OU behaviors de cada grupo
 *  do `flexible_spec`; grupo vazio é descartado. O `t.interests` legado (plano) vira 1 grupo. */
function collectGroupRefs(t: RawTargeting, pick: "interests" | "behaviors"): { id: string; name: string }[][] {
  const groups: { id: string; name: string }[][] = [];
  const refsToGroup = (refs: readonly RawAudienceRef[] | undefined): { id: string; name: string }[] =>
    (refs ?? []).filter((r): r is RawAudienceRef & { id: string; name: string } => !!r.id && !!r.name).map((r) => ({ id: r.id, name: r.name }));
  for (const group of t.flexible_spec ?? []) {
    const g = refsToGroup(group[pick]);
    if (g.length > 0) groups.push(g);
  }
  if (pick === "interests") {
    const legacy = refsToGroup(t.interests);
    if (legacy.length > 0) groups.push(legacy);
  }
  return groups;
}

function geoLabels(t: RawTargeting): string[] {
  const geo = t.geo_locations;
  if (!geo) return [];
  if (geo.countries && geo.countries.length > 0) return [...geo.countries];
  const regions = (geo.regions ?? []).map((r) => r.name).filter((n): n is string => !!n);
  const cities = (geo.cities ?? []).map((c) => c.name).filter((n): n is string => !!n);
  return [...regions, ...cities];
}

/** Regiões/cidades com `key` preservado — necessário pra reconstruir `geo_locations` sem reler a
 *  fonte (ex: remover 1 cidade do que já foi herdado). Países ficam de fora (usam ISO, sem `key`). */
function geoEntries(t: RawTargeting): { key: string; name: string; kind: "city" | "region" }[] {
  const geo = t.geo_locations;
  if (!geo) return [];
  const withKey = (r: RawAudienceRef): r is RawAudienceRef & { key: string; name: string } => !!r.key && !!r.name;
  const regions = (geo.regions ?? []).filter(withKey).map((r) => ({ key: r.key, name: r.name, kind: "region" as const }));
  const cities = (geo.cities ?? []).filter(withKey).map((c) => ({ key: c.key, name: c.name, kind: "city" as const }));
  return [...regions, ...cities];
}

/** Leitura NEUTRA e honesta dos 3 flags de expansão — só descreve o que a fonte tem (`raw`, ausente
 *  quando a fonte não configurou aquele flag) + `summary` pro eco/UI. Nunca decide nada (quem decide
 *  fechar por ausência é `resolveExpansion`, na camada de resolução, com o `raw` daqui). */
function expansionRead(t: RawTargeting): AudienceProfile["expansion"] {
  const aa = t.targeting_automation?.advantage_audience;
  const rc = t.targeting_relaxation_types?.custom_audience;
  const rl = t.targeting_relaxation_types?.lookalike;
  const summary: "off" | "on" | "unknown" =
    aa === 1 || rc === 1 || rl === 1 ? "on" : aa === undefined && rc === undefined && rl === undefined ? "unknown" : "off";
  return {
    summary,
    ...(aa !== undefined ? { advantageAudience: aa } : {}),
    ...(rc !== undefined ? { relaxCustomAudience: rc } : {}),
    ...(rl !== undefined ? { relaxLookalike: rl } : {}),
  };
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
  const entries = geoEntries(t);
  const interestGroupRefs = collectGroupRefs(t, "interests");
  const behaviorGroupRefs = collectGroupRefs(t, "behaviors");

  return {
    stage,
    customAudienceCount: inclusion.length,
    exclusionCount: exclusions.length,
    ...(geo.length > 0 ? { geo } : {}),
    ...(entries.length > 0 ? { geoEntries: entries } : {}),
    ...(t.age_min !== undefined ? { ageMin: t.age_min } : {}),
    ...(t.age_max !== undefined ? { ageMax: t.age_max } : {}),
    ...(interests.length > 0 ? { interests } : {}),
    ...(interestGroupRefs.length > 0 ? { interestGroupRefs } : {}),
    ...(behaviorGroupRefs.length > 0 ? { behaviorGroupRefs } : {}),
    // ids dos públicos salvos (Slice 9) — pra a cópia reuse_adset de remarketing não virar frio.
    ...(() => {
      const inc = inclusion.filter((a): a is typeof a & { id: string } => !!a.id).map((a) => a.id);
      const exc = exclusions.filter((a): a is typeof a & { id: string } => !!a.id).map((a) => a.id);
      return { ...(inc.length > 0 ? { customAudienceIncludeIds: inc } : {}), ...(exc.length > 0 ? { customAudienceExcludeIds: exc } : {}) };
    })(),
    expansion: expansionRead(t),
  };
}
