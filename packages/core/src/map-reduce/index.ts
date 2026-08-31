// Núcleo PURO do map-reduce por entidade (3b-2). Decide QUAIS unidades reanalisar
// (política por-agente) e reduz as análises por-unidade num resultado da conta.
// Testável sem mock; o grafo (casca) só chama + faz o IO (LLM/DB).

import type { CampaignUnit, Creative, EntitySummary, InsightMetrics } from "@trafego/shared";
import type { AnalysisOutput, UnitAnalysis } from "@trafego/shared";

/** Mínimo de adsets ATIVOS pra uma campanha ABO ganhar diagnóstico por-adset (S8b). */
const MIN_ADSETS_FOR_ADSET_TIERING = 2;

export type ExecutionPolicy = "deep_periodic_incremental" | "full_every_run" | "budget_scaled";

/** Última análise de uma unidade (p/ herança/detecção de mudança material). */
export interface LastUnit {
  readonly metrics: Partial<InsightMetrics>;
  readonly flags: readonly string[];
}

export interface SelectUnitsConfig {
  readonly policy: ExecutionPolicy;
  /** variação relativa (%) de métrica que torna a unidade "materialmente mudada". */
  readonly materialChangePct: number;
  /** run DEEP (reanalisa tudo) — decidido na casca pelo último deep. */
  readonly isDeepRun: boolean;
  /** teto de unidades neste run (budget_scaled). */
  readonly maxUnitsThisRun?: number;
}

export interface UnitSelection {
  readonly toAnalyze: readonly EntitySummary[];
  readonly toInherit: readonly EntitySummary[];
  /** sem análise nova nem herança possível (budget estourado, sem histórico). */
  readonly dropped: readonly EntitySummary[];
}

/** Métricas cuja variação dispara reanálise (as que movem a decisão). */
const TRACKED: readonly (keyof InsightMetrics)[] = ["spend", "cpa", "roas", "ctr"];
const EPSILON = 1e-9;

/** A unidade mudou o bastante desde a última análise (ou é nova / mudou de flag)? */
export function isMateriallyChanged(unit: EntitySummary, last: LastUnit | undefined, pct: number): boolean {
  if (!last) return true; // nova → analisa
  if (!sameFlags(unit.flags, last.flags)) return true;
  for (const m of TRACKED) {
    const cur = unit.metrics[m];
    const prev = last.metrics[m];
    const curDef = typeof cur === "number";
    const prevDef = typeof prev === "number";
    if (curDef !== prevDef) return true; // apareceu/sumiu uma métrica
    if (curDef && prevDef) {
      const rel = (Math.abs(cur - prev) / Math.max(Math.abs(prev), EPSILON)) * 100;
      if (rel > pct) return true;
    }
  }
  return false;
}

function sameFlags(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const sb = new Set(b);
  return a.every((f) => sb.has(f));
}

/**
 * Decide o subconjunto a reanalisar neste run conforme a política. Puro.
 *  - full_every_run: tudo.
 *  - deep_periodic_incremental: deep → tudo; senão só as materialmente mudadas/novas.
 *  - budget_scaled: prioriza por gasto até o teto; o resto herda (ou cai, se sem histórico).
 */
export function selectUnitsToAnalyze(
  units: readonly EntitySummary[],
  lastByEntityId: ReadonlyMap<string, LastUnit>,
  cfg: SelectUnitsConfig,
): UnitSelection {
  // budget_scaled é uma política de TETO: respeita `maxUnitsThisRun` sempre —
  // inclusive em deep/on-demand (senão o pico de custo furava o orçamento).
  if (cfg.policy === "budget_scaled") {
    const bySpend = [...units].sort((a, b) => (b.metrics.spend ?? 0) - (a.metrics.spend ?? 0));
    const cap = cfg.maxUnitsThisRun ?? bySpend.length;
    const toAnalyze = bySpend.slice(0, cap);
    const rest = bySpend.slice(cap);
    const toInherit = rest.filter((u) => lastByEntityId.has(u.id));
    const dropped = rest.filter((u) => !lastByEntityId.has(u.id));
    return { toAnalyze, toInherit, dropped };
  }

  if (cfg.policy === "full_every_run" || cfg.isDeepRun) {
    return { toAnalyze: units, toInherit: [], dropped: [] };
  }

  // deep_periodic_incremental (dia comum): só as que mudaram materialmente / novas.
  const toAnalyze: EntitySummary[] = [];
  const toInherit: EntitySummary[] = [];
  for (const u of units) {
    if (isMateriallyChanged(u, lastByEntityId.get(u.id), cfg.materialChangePct)) toAnalyze.push(u);
    else toInherit.push(u);
  }
  return { toAnalyze, toInherit, dropped: [] };
}

/**
 * Poster-frames do criativo p/ a visão (Fatia 6c): usa `posterFrames` (imagem = 1;
 * vídeo = N frames HD do adapter) quando presente; senão cai no `imageUrl`/
 * `thumbnailUrl` (compat). Meta bloqueia o `source` de vídeo — usamos os stills.
 */
export function creativePosterFrames(c: Creative): readonly string[] {
  if (c.posterFrames && c.posterFrames.length > 0) return c.posterFrames;
  const single = c.imageUrl ?? c.thumbnailUrl;
  return single ? [single] : [];
}

/** Criativos das unidades analisadas (por adId), com teto de segurança. */
export function selectCreatives(
  analyzedUnitIds: readonly string[],
  creativesByAdId: ReadonlyMap<string, readonly Creative[]>,
  cap: number,
): Creative[] {
  const out: Creative[] = [];
  for (const id of analyzedUnitIds) {
    for (const c of creativesByAdId.get(id) ?? []) {
      if (out.length >= cap) return out;
      out.push(c);
    }
  }
  return out;
}

/**
 * Redução determinística (fallback da síntese LLM): junta findings/recomendações
 * das unidades, deduplica por título e deriva um scorecard heurístico (sem inventar
 * números — grade pela pior severidade). Usada quando o sintetizador LLM falha.
 */
export function mergeUnitAnalyses(units: readonly UnitAnalysis[]): AnalysisOutput {
  const findings = dedupeByTitle(units.flatMap((u) => u.findings));
  const recommendations = dedupeByTitle(units.flatMap((u) => u.recommendations));
  const grade = gradeFromFindings(findings);
  return {
    scorecard: {
      grade,
      headline: findings[0]?.title ?? "Análise consolidada das campanhas.",
      biggestLeak: "conversao",
    },
    summary: `Análise consolidada de ${units.length} campanha(s): ${findings.length} achado(s), ${recommendations.length} recomendação(ões).`,
    findings,
    recommendations,
  };
}

/**
 * Diagnóstico por-adset (S8b) DERIVADO da MESMA call de campanha já feita — zero LLM extra.
 * Só campanhas ABO (sem budget próprio) com 2+ adsets ATIVOS ganham entrada por-adset (CBO/
 * 1-adset continuam só por campanha — a assimetria é intencional: quem controla o próprio
 * budget é o adset, então só ele merece diagnóstico próprio). Cada entrada carrega SÓ as
 * recomendações cujo `targetEntity` mira aquele adset + os findings referenciados por elas
 * (`findingRefs`) — o analista já pode apontar `targetEntity: {level: "adset"}` na call
 * existente (schema já suporta), então filtrar o já-produzido é honesto e não inventa nada.
 * Puro.
 */
export function deriveAdsetUnits(
  unit: CampaignUnit,
  analysis: UnitAnalysis,
): ReadonlyArray<{ readonly adset: EntitySummary; readonly unit: UnitAnalysis }> {
  const isABO = unit.campaign.budget == null;
  if (!isABO || unit.adsets.length < MIN_ADSETS_FOR_ADSET_TIERING) return [];

  return unit.adsets.map((group) => {
    const recommendations = analysis.recommendations.filter(
      (r) => r.targetEntity?.level === "adset" && r.targetEntity.externalId === group.adset.id,
    );
    const refIds = new Set(recommendations.flatMap((r) => r.findingRefs ?? []));
    const findings = analysis.findings.filter((f) => refIds.has(f.id));
    const summary =
      recommendations.length > 0
        ? `Conjunto dentro de campanha com orçamento por conjunto (ABO) — ${recommendations.length} recomendação(ões) específica(s) deste conjunto.`
        : "Conjunto dentro de campanha com orçamento por conjunto (ABO) — sem recomendação específica deste conjunto nesta análise.";
    return { adset: group.adset, unit: { summary, findings, recommendations, flags: [...group.adset.flags] } };
  });
}

function dedupeByTitle<T extends { readonly title: string }>(items: readonly T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const it of items) {
    const key = it.title.trim().toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(it);
  }
  return out;
}

function gradeFromFindings(findings: readonly { readonly severity: string }[]): "A" | "B" | "C" | "D" {
  if (findings.some((f) => f.severity === "critical")) return "D";
  if (findings.some((f) => f.severity === "warning")) return "C";
  if (findings.length > 0) return "B";
  return "A";
}

export {
  selectCampaignsToAnalyze,
  type CampaignSelection,
  type SelectCampaignsConfig,
} from "./campaign-selection.js";
