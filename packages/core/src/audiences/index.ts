// Helpers puros de PÚBLICO (Fatia 7). O match nome→id reusa `resolveNamedMatch` (core);
// aqui vai a heurística de EXCLUSÃO de convertidos (remarketing limpo) + a leitura da
// estimativa de alcance combinado. Sem IO.

import type { AudienceProfile, DeliveryEstimate, DistanceUnit, ResolvedAudienceSnapshot } from "@trafego/shared/types";

/**
 * Limites de RAIO da Meta por âncora (Slice 5, confirmados na doc + spike): cidade 17–80 km
 * (10–50 mi); endereço 1–80 km (0.63–50 mi). Fora do limite → CLAMPA pro mais próximo + nota
 * (estilo guardrail de budget), nunca trava. Pura.
 */
const RADIUS_LIMITS: Record<"city" | "address", Record<DistanceUnit, { readonly min: number; readonly max: number }>> = {
  city: { kilometer: { min: 17, max: 80 }, mile: { min: 10, max: 50 } },
  address: { kilometer: { min: 1, max: 80 }, mile: { min: 0.63, max: 50 } },
};

export function clampRadius(
  radius: number,
  unit: DistanceUnit,
  anchor: "city" | "address",
): { readonly radius: number; readonly note?: string } {
  const { min, max } = RADIUS_LIMITS[anchor][unit];
  const unitLabel = unit === "kilometer" ? "km" : "mi";
  if (radius < min) return { radius: min, note: `ajustei o raio pra ${min} ${unitLabel} (mínimo da Meta pra ${anchor === "city" ? "cidade" : "endereço"})` };
  if (radius > max) return { radius: max, note: `ajustei o raio pra ${max} ${unitLabel} (máximo da Meta)` };
  return { radius };
}

/** Nomes que denunciam um público de quem JÁ CONVERTEU — candidatos a exclusão no remarketing. */
const CONVERTER_HINTS = ["lead", "compra", "comprad", "client", "agenda", "venda", "checkout", "purchase", "buyer"] as const;

interface AudienceRef {
  readonly id: string;
  readonly name: string;
  readonly isLookalike?: boolean;
}

/** O nome sugere um público de convertidos (lead/compra/cliente/agendamento…)? */
export function isConverterAudienceName(name: string): boolean {
  const lower = name.toLowerCase();
  return CONVERTER_HINTS.some((h) => lower.includes(h));
}

/**
 * Sugere públicos a EXCLUIR num remarketing: os que parecem "já converteu" (pelo nome), que
 * NÃO estão sendo incluídos e NÃO são lookalike (lookalike é frio, não é convertido). Puro —
 * a casca anexa ao rascunho e o eco+confirma deixa o dono ver/tirar. Vazio = nada a sugerir.
 */
export function suggestConverterExclusions(
  audiences: readonly AudienceRef[],
  includeIds: readonly string[],
): string[] {
  const included = new Set(includeIds);
  return audiences
    .filter((a) => !included.has(a.id) && !a.isLookalike && isConverterAudienceName(a.name))
    .map((a) => a.id);
}

/**
 * Piso de privacidade da Meta: `delivery_estimate` devolve 1000 como valor MÍNIMO reportável (custom
 * audiences pequenas/privadas são achatadas nele). Alcance ≤ piso = a plataforma NÃO revelou o tamanho
 * real → não é sinal informativo → degrada pro sinal por-público (que mostra a mesma ordem). */
const META_REACH_FLOOR = 1000;
/** Alcance MENSAL abaixo do qual um público arrisca não entregar bem (acima do piso, mas ainda magro). */
const MIN_MONTHLY_REACH = 10_000;

/** Número compacto em PT (1500 → "1,5 mil", 25000 → "25 mil", 1_200_000 → "1,2 mi"). */
function humanCount(n: number): string {
  const ptDecimal = (v: number): string => (Math.round(v * 10) / 10).toString().replace(".", ",");
  if (n >= 1_000_000) return `${ptDecimal(n / 1_000_000)} mi`;
  if (n >= 1000) return `${ptDecimal(n / 1000)} mil`;
  return `${Math.round(n)}`;
}

/** Faixa "~X–Y" (ou "~X" quando min==max) já em formato PT compacto. */
function reachRange(min: number, max: number): string {
  return min === max ? `~${humanCount(max)}` : `~${humanCount(min)}–${humanCount(max)}`;
}

/**
 * Decide os 3 flags de expansão pra um targeting NOVO que herda de uma fonte (P0/P1 — honestidade +
 * segurança de gasto). Ausente na fonte → fecha explícito (nunca herda expansão às cegas — a Meta
 * default 1 na CRIAÇÃO de adset quando ausente, v23+, mas essa regra é neutra: qualquer plataforma
 * futura com um flag de expansão análogo se comporta igual) + nota. Presente (0 ou 1) → respeita a
 * escolha real do dono + nota quando ligado. Pura, testável sem mock.
 */
export function resolveExpansion(raw: {
  readonly advantageAudience?: 0 | 1;
  readonly relaxCustomAudience?: 0 | 1;
  readonly relaxLookalike?: 0 | 1;
}): {
  readonly expansionRaw: ResolvedAudienceSnapshot["expansionRaw"];
  readonly summary: "off" | "on";
  readonly note?: string;
} {
  const advantageAudience = raw.advantageAudience ?? 0;
  const relaxCustomAudience = raw.relaxCustomAudience ?? 0;
  const relaxLookalike = raw.relaxLookalike ?? 0;
  const anyOn = advantageAudience === 1 || relaxCustomAudience === 1 || relaxLookalike === 1;
  const anyAbsent = raw.advantageAudience === undefined || raw.relaxCustomAudience === undefined || raw.relaxLookalike === undefined;
  const note = anyOn
    ? "a fonte já usa expansão de público ligada"
    : anyAbsent
      ? "a fonte não tinha expansão configurada — apliquei fechado por segurança"
      : undefined;
  return { expansionRaw: { advantageAudience, relaxCustomAudience, relaxLookalike }, summary: anyOn ? "on" : "off", ...(note ? { note } : {}) };
}

/** Geo do `AudienceProfile` lido → shape AGRUPADO do snapshot (país nunca convive com região/cidade). */
function snapshotGeoFromProfile(profile: AudienceProfile): ResolvedAudienceSnapshot["geo"] {
  const entries = profile.geoEntries ?? [];
  if (entries.length > 0) {
    const regions = entries.filter((e) => e.kind === "region").map((e) => ({ key: e.key, name: e.name }));
    const cities = entries.filter((e) => e.kind === "city").map((e) => ({ key: e.key, name: e.name }));
    return { ...(regions.length > 0 ? { regions } : {}), ...(cities.length > 0 ? { cities } : {}) };
  }
  return profile.geo && profile.geo.length > 0 ? { countries: [...profile.geo] } : {};
}

/** `AudienceProfile` lido → snapshot resolvido pra gravar no rascunho — a expansão passa por
 *  `resolveExpansion` (NUNCA herda ausente às cegas; congela OFF quando desconhecida). Pura. Fonte
 *  ÚNICA usada por worker (propose) E api (toggle reuse) → o `reuse_adset` nasce SEMPRE com retrato. */
export function buildResolvedSnapshot(profile: AudienceProfile): ResolvedAudienceSnapshot {
  const { expansionRaw } = resolveExpansion(profile.expansion);
  return {
    geo: snapshotGeoFromProfile(profile),
    ...(profile.ageMin !== undefined ? { ageMin: profile.ageMin } : {}),
    ...(profile.ageMax !== undefined ? { ageMax: profile.ageMax } : {}),
    // Slice 6: preserva interesses/comportamentos da fonte (com id) no snapshot → a cópia reuse_adset
    // não perde mais o targeting detalhado no apply.
    ...(profile.interestGroupRefs && profile.interestGroupRefs.length > 0 ? { interestGroups: profile.interestGroupRefs } : {}),
    ...(profile.behaviorGroupRefs && profile.behaviorGroupRefs.length > 0 ? { behaviorGroups: profile.behaviorGroupRefs } : {}),
    expansionRaw,
  };
}

/**
 * Lê a estimativa de alcance COMBINADO (includes − excludes + geo/idade) numa nota honesta pro eco. A
 * Meta (v26) devolve o alcance MENSAL como FAIXA (`estimate_mau_*`); o antigo `estimate_dau` vem raro,
 * usado só de fallback. `ready:false`, sem contagem, ou achatado no piso de privacidade (≤1000) → `null`
 * (o caller degrada pro sinal por-público). Abaixo do piso de entrega → ⚠️ "pode entregar pouco"; saudável
 * → nota informativa (sem alarme). Puro/testável.
 */
export function describeDeliveryEstimate(estimate: DeliveryEstimate): string | null {
  if (!estimate.ready) return null;
  // Preferência: faixa MENSAL (o que a Meta realmente devolve); fallback ao DAU pontual (raro).
  if (estimate.monthlyReachMax != null) {
    const max = estimate.monthlyReachMax;
    const min = estimate.monthlyReachMin ?? max;
    if (max <= META_REACH_FLOOR) return null; // achatado no piso → não informativo → fallback por-público
    const range = reachRange(min, max);
    if (max < MIN_MONTHLY_REACH) {
      return `⚠️ alcance estimado pequeno (${range} pessoas/mês) — pode entregar pouco.`;
    }
    return `Alcance estimado: ${range} pessoas/mês com esse público.`;
  }
  if (estimate.dailyActiveUsers != null) {
    const dau = estimate.dailyActiveUsers;
    if (dau <= META_REACH_FLOOR) return null;
    const human = `~${humanCount(dau)}`;
    if (dau < MIN_MONTHLY_REACH) return `⚠️ alcance diário estimado pequeno (${human} pessoas/dia) — pode entregar pouco.`;
    return `Alcance estimado: ${human} pessoas ativas/dia com esse público.`;
  }
  return null;
}
