// Detectores TEMPORAIS de conta (Classe B, v3) — puros. Regularidades DINÂMICAS que só saem
// da série de vários runs (insights_snapshots, já persistido) e servem a conta 100% passiva:
// não é "está zumbi agora" (o run já vê isso), é TIMING/dinâmica. Cada detector devolve uma
// `LessonCandidate` de escopo CONTA (prior de PROMPT — ressalva conservadora) OU null quando o
// padrão é disperso/ralo (barra anti-ruído: ≥K + variância baixa + histórico mínimo). A
// confiança é pontuada pela FORÇA estatística (padrão apertado nasce forte o bastante p/ o
// prompt; disperso fica "explorando", só visível). O redator traduz; aqui nada é inventado.

import type { LessonCandidate } from "./index.js";

// ─── Modelo de confiança temporal (força estatística, não teto observacional fixo) ─────
/** Teto da confiança de um prior temporal SEM confirmação humana (acima do observacional, p/
 *  um padrão apertado alcançar o prompt; abaixo do medido de ação nossa). */
export const TEMPORAL_CONFIDENCE_CAP = 0.85;
// ganho por passo: calibrado p/ um padrão APERTADO (baixa variância) em K=3 alcançar o limiar
// do prompt (~0,7), enquanto um disperso (strength baixa) fica em "explorando"/guard.
const TEMPORAL_APPROACH_RATE = 0.6;

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

/**
 * Confiança do prior temporal: aproxima do teto `count` vezes com ganho decrescente,
 * proporcional à FORÇA `strength` (0..1). Com cap 0,85 e rate 0,6, count=3 & strength=1 → ~0,80
 * (acima do limiar do prompt, 0,70); um padrão APERTADO mas não perfeito (strength ~0,8) ainda
 * cruza 0,70, enquanto um disperso (strength baixa) fica abaixo (só guard/explorando). Pura.
 */
export function temporalConfidence(count: number, strength: number): number {
  const s = clamp01(strength);
  let c = 0;
  for (let i = 0; i < count; i++) c = c + (TEMPORAL_CONFIDENCE_CAP - c) * TEMPORAL_APPROACH_RATE * s;
  return clamp01(c);
}

// ─── (1) Timing de fadiga de criativo ─────────────────────────────────────
/** Série de CTR (%) de UMA campanha, cronológica desde o início (índice 0 = 1º dia). */
export interface CampaignFatigueSeries {
  readonly campaignId: string;
  readonly ctrByDay: readonly number[];
}

export interface FatigueTimingConfig {
  /** mínimo de campanhas com um dia-de-fadiga p/ o padrão nascer (K). */
  readonly minCampaigns: number;
  /** mínimo de dias na série de uma campanha p/ ela contar. */
  readonly minDays: number;
  /** dias iniciais que definem o CTR de REFERÊNCIA (pico da largada). */
  readonly earlyWindowDays: number;
  /** fadiga = CTR cai ao menos esta fração vs a referência (0..1). */
  readonly ctrDropFrac: number;
  /** variância baixa: coeficiente de variação (desvio/média) MÁXIMO dos dias-de-fadiga. */
  readonly maxCoefVariation: number;
}

export const DEFAULT_FATIGUE_TIMING: FatigueTimingConfig = {
  minCampaigns: 3,
  minDays: 5,
  earlyWindowDays: 3,
  ctrDropFrac: 0.3,
  maxCoefVariation: 0.35,
};

/** Dia (índice desde o início) em que o CTR caiu abaixo da referência inicial — ou null. */
function firstFatigueDay(ctrByDay: readonly number[], cfg: FatigueTimingConfig): number | null {
  if (ctrByDay.length < cfg.minDays) return null;
  const early = ctrByDay.slice(0, cfg.earlyWindowDays).filter((v) => v > 0);
  if (early.length === 0) return null;
  const reference = Math.max(...early);
  const floor = reference * (1 - cfg.ctrDropFrac);
  for (let day = cfg.earlyWindowDays; day < ctrByDay.length; day++) {
    if (ctrByDay[day]! < floor) return day;
  }
  return null;
}

/**
 * Detecta o TIMING típico de fadiga de criativo da conta: em quantos dias após o lançamento o
 * CTR costuma cair. Só nasce com ≥K campanhas exibindo um dia-de-fadiga E variância baixa entre
 * eles (padrão disperso não nasce). Prior de PROMPT (ressalva preventiva conservadora: preparar
 * renovação antes). Pura.
 */
export function detectFatigueTimingPrior(
  campaigns: readonly CampaignFatigueSeries[],
  config: Partial<FatigueTimingConfig> = {},
): LessonCandidate | null {
  const cfg = { ...DEFAULT_FATIGUE_TIMING, ...config };
  const days = campaigns.map((c) => firstFatigueDay(c.ctrByDay, cfg)).filter((d): d is number => d !== null);
  if (days.length < cfg.minCampaigns) return null;
  const mean = days.reduce((a, b) => a + b, 0) / days.length;
  if (mean <= 0) return null;
  const variance = days.reduce((a, d) => a + (d - mean) ** 2, 0) / days.length;
  const cv = Math.sqrt(variance) / mean;
  if (cv > cfg.maxCoefVariation) return null; // disperso → não nasce
  const strength = clamp01(1 - cv / cfg.maxCoefVariation); // 1 = perfeitamente apertado
  return {
    kind: "fact",
    key: { scope: "account", dimension: "creative", direction: "neutral" },
    origin: "observational",
    confidence: temporalConfidence(days.length, strength),
    evidence: { pattern: "account_fatigue_timing", occurrences: days.length, totalRuns: days.length, days: Math.round(mean) },
  };
}

// ─── (2) Lag de conversão ──────────────────────────────────────────────────
/** Ponto diário da CONTA (soma das campanhas), cronológico. */
export interface AccountConversionDay {
  readonly spend: number;
  readonly conversions: number;
}

export interface ConversionLagConfig {
  /** histórico mínimo de dias p/ arriscar a cross-correlação. */
  readonly minDays: number;
  /** lag máximo (dias) a testar. */
  readonly maxLagDays: number;
  /** correlação mínima (0..1) no melhor lag p/ o padrão valer. */
  readonly minCorrelation: number;
}

export const DEFAULT_CONVERSION_LAG: ConversionLagConfig = {
  minDays: 14,
  maxLagDays: 7,
  minCorrelation: 0.5,
};

/** Correlação de Pearson entre dois vetores de mesmo tamanho (0 se degenerado). */
function pearson(xs: readonly number[], ys: readonly number[]): number {
  const n = xs.length;
  if (n < 2) return 0;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < n; i++) {
    const a = xs[i]! - mx;
    const b = ys[i]! - my;
    num += a * b;
    dx += a * a;
    dy += b * b;
  }
  const den = Math.sqrt(dx * dy);
  return den === 0 ? 0 : num / den;
}

/**
 * Detecta o LAG típico de conversão da conta: quantos dias a conversão atrasa em relação ao
 * gasto (cross-correlação gasto(t) × conversão(t+d)). Só nasce quando o melhor lag ≥ 1 dia, sua
 * correlação ≥ mínimo E supera a do lag 0 (o atraso REALMENTE ajuda). Prior de PROMPT (ressalva
 * conservadora: não julgar campanha nova como sem resultado cedo demais). Pura.
 */
export function detectConversionLagPrior(
  daysSeries: readonly AccountConversionDay[],
  config: Partial<ConversionLagConfig> = {},
): LessonCandidate | null {
  const cfg = { ...DEFAULT_CONVERSION_LAG, ...config };
  if (daysSeries.length < cfg.minDays) return null;
  const spend = daysSeries.map((d) => d.spend);
  const conv = daysSeries.map((d) => d.conversions);
  const corrAt = (lag: number): number => {
    const n = daysSeries.length - lag;
    if (n < 2) return 0;
    return pearson(spend.slice(0, n), conv.slice(lag, lag + n));
  };
  const base = corrAt(0);
  let bestLag = 0;
  let bestCorr = -Infinity;
  for (let lag = 1; lag <= cfg.maxLagDays; lag++) {
    const c = corrAt(lag);
    if (c > bestCorr) {
      bestCorr = c;
      bestLag = lag;
    }
  }
  if (bestLag < 1 || bestCorr < cfg.minCorrelation || bestCorr <= base) return null;
  const strength = clamp01((bestCorr - cfg.minCorrelation) / (1 - cfg.minCorrelation));
  // 3 "passos" (equivalente a K campanhas): correlação forte → ~0,70 (alcança o prompt).
  return {
    kind: "fact",
    key: { scope: "account", dimension: "conversion", direction: "neutral" },
    origin: "observational",
    confidence: temporalConfidence(CONVERSION_LAG_CONFIDENCE_STEPS, strength),
    evidence: { pattern: "account_conversion_lag", occurrences: 1, totalRuns: 1, days: bestLag },
  };
}

/** Passos do fold de confiança do lag (equivalente a K campanhas) — correlação forte alcança o prompt. */
const CONVERSION_LAG_CONFIDENCE_STEPS = 3;
