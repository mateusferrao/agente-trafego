import type { AccountBrief, EntitySummary, FunnelSummary, InsightMetrics } from "@trafego/shared";
import type { AnalysisFinding, AnalysisOutput } from "@trafego/shared";

/**
 * Guards determinísticos sobre a saída do LLM (§ princípio-guia: rede que não
 * depende do modelo). Dois níveis:
 *  - HARD (drop): finding sem `metricRefs` OU cujos números citados NÃO existem no
 *    brief (nenhum confere) → descartado. Nosso análogo do "merge autoritativo":
 *    o número que não está no brief não sustenta o achado.
 *  - SOFT (flag): os problemas são coletados p/ alimentar o revisor corrigir antes
 *    do drop final. Lenientes: 1 métrica que confere já sustenta o finding.
 */

export type FindingIssueReason = "no_metric_ref" | "unverifiable_number";
export interface FindingIssue {
  readonly findingId: string;
  readonly reason: FindingIssueReason;
  readonly detail: string;
}

const ROUND_2 = 100;

/** Junta todos os números conhecidos do brief (arredondados) — o "gabarito". */
export function collectBriefNumbers(brief: AccountBrief): Set<number> {
  const nums = new Set<number>();
  const addMetrics = (m: Partial<InsightMetrics> | undefined): void => {
    if (!m) return;
    for (const v of Object.values(m)) if (typeof v === "number") addNumber(nums, v);
  };
  const addFunnel = (f: FunnelSummary | undefined): void => {
    if (!f) return;
    for (const v of Object.values(f.counts)) if (typeof v === "number") addNumber(nums, v);
    if (f.replyRate !== undefined) addNumber(nums, f.replyRate);
    if (f.depthRate !== undefined) addNumber(nums, f.depthRate);
  };
  const addEntity = (e: EntitySummary): void => {
    addMetrics(e.metrics);
    addMetrics(e.deltaVsBaseline);
    addFunnel(e.funnel);
  };

  addMetrics(brief.totals);
  addMetrics(brief.totals.delta);
  addFunnel(brief.funnel);
  for (const e of brief.segments.campaigns) addEntity(e);
  for (const e of brief.segments.adsets) addEntity(e);
  for (const e of brief.segments.ads) addEntity(e);
  // trends fazem parte do brief mostrado ao LLM → seus números são citáveis (senão
  // um finding que cita corretamente um ponto da série seria descartado por engano).
  for (const t of brief.trends) addMetrics(t.metrics);
  addNumber(nums, brief.aggregatesRest.spend);
  if (brief.aggregatesRest.avgCpa !== undefined) addNumber(nums, brief.aggregatesRest.avgCpa);
  return nums;
}

/**
 * Um número é verificável se seu valor (2dp) existe no gabarito. O fallback p/
 * inteiro só vale em magnitudes >= 1 (senão taxas pequenas — replyRate 0.15,
 * ctr 2 — colapsariam no mesmo inteiro e "verificariam" um número alucinado).
 */
function isVerifiable(value: number, known: ReadonlySet<number>): boolean {
  if (known.has(round2(value))) return true;
  return Math.abs(value) >= 1 && known.has(Math.round(value));
}

/** Finding sustentado? tem metricRefs e (nenhum número OU ≥1 número que confere). */
function findingIssue(finding: AnalysisFinding, known: ReadonlySet<number>): FindingIssue | null {
  if (finding.metricRefs.length === 0) {
    return { findingId: finding.id, reason: "no_metric_ref", detail: "sem métrica de suporte" };
  }
  const numeric = finding.metricRefs.filter((r): r is { label: string; value: number } => typeof r.value === "number");
  if (numeric.length === 0) return null; // só rótulos textuais → não dá p/ verificar número
  if (numeric.some((r) => isVerifiable(r.value, known))) return null; // ≥1 confere → sustenta
  return { findingId: finding.id, reason: "unverifiable_number", detail: "números citados não batem com o brief" };
}

/** Coleta os problemas (p/ o revisor). Não modifica a saída. */
export function flagUnsupportedFindings(output: AnalysisOutput, brief: AccountBrief): FindingIssue[] {
  const known = collectBriefNumbers(brief);
  return output.findings.map((f) => findingIssue(f, known)).filter((i): i is FindingIssue => i !== null);
}

/** Descarte final (hard): remove os findings problemáticos. Puro. */
export function dropUnsupportedFindings(output: AnalysisOutput, brief: AccountBrief): AnalysisOutput {
  const known = collectBriefNumbers(brief);
  const findings = output.findings.filter((f) => findingIssue(f, known) === null);
  return { ...output, findings };
}

function addNumber(set: Set<number>, value: number): void {
  set.add(round2(value));
  // inteiro só p/ magnitudes >= 1 (simétrico ao isVerifiable — não polui o gabarito
  // com o 0 de uma taxa pequena, que validaria alucinações).
  if (Math.abs(value) >= 1) set.add(Math.round(value));
}
function round2(x: number): number {
  return Math.round(x * ROUND_2) / ROUND_2;
}
