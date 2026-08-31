import type { AccountBrief, ConversionBasis, DecisionEligibility, EntitySummary, FunnelSummary, InsightMetrics, TrackingHealth } from "@trafego/shared";
import type { AnalysisFinding, AnalysisOutput, RecommendationActionType } from "@trafego/shared";
import { flagUngroundedNumbers } from "../chat-guards/index.js";

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
  // agregados determinísticos (Bloco 2) — o LLM PODE citá-los (WASTE_NOTE/TRACKING_NOTE
  // pedem o "money shot" em reais); sem eles no gabarito, o drop comeria o próprio finding.
  if (brief.waste) {
    addNumber(nums, brief.waste.wastedSpend);
    addNumber(nums, brief.waste.wastedPct);
    for (const z of brief.waste.zombies) addNumber(nums, z.spend);
    if (brief.waste.pareto) {
      addNumber(nums, brief.waste.pareto.groupSpend);
      for (const i of brief.waste.pareto.items) {
        addNumber(nums, i.spend);
        addNumber(nums, i.spendPct);
        if (i.result !== undefined) addNumber(nums, i.result);
        if (i.resultPct !== undefined) addNumber(nums, i.resultPct);
      }
    }
  }
  if (brief.trackingHealth) {
    addNumber(nums, brief.trackingHealth.funnelStarted);
    addNumber(nums, brief.trackingHealth.trackedConversions);
    addNumber(nums, brief.trackingHealth.ratio);
  }
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

/**
 * Finding sustentado? tem metricRefs e (nenhum número OU ≥1 número que confere).
 * EXCEÇÃO (G4): `caveat=true` carve-out do requisito de metricRefs — achado QUALITATIVO/
 * compliance sem número que o sustente (ex: risco de linguagem regulada). NUNCA afrouxa a
 * verificação de número quando `metricRefs` está preenchido (com caveat ou sem) — E o carve-out
 * em si não é um free-pass pra "esconder" um número inventado em PROSA (title/detail): reusa o
 * scanner de dinheiro/% do chat (`flagUngroundedNumbers`, packages/core/src/chat-guards) contra
 * o mesmo gabarito, mesma classe de menor falso-positivo já validada nesse guard.
 */
function findingIssue(finding: AnalysisFinding, known: ReadonlySet<number>): FindingIssue | null {
  if (finding.metricRefs.length === 0) {
    if (finding.caveat) {
      const ungrounded = flagUngroundedNumbers(`${finding.title} ${finding.detail}`, known);
      if (ungrounded.length === 0) return null;
      const kind = ungrounded[0]!.kind === "money" ? "valor" : "percentual";
      return { findingId: finding.id, reason: "unverifiable_number", detail: `caveat cita ${kind} que não bate com o brief` };
    }
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

// ─── Guard de significância (Fatia 6c) ────────────────────────────────────
// Veto determinístico do squad ("never scale without significance / in learning
// phase"): NÃO manda escalar/reativar sem base estatística. Ações defensivas
// (pausar/reduzir) nunca são barradas — reduzir risco é sempre seguro.

/** Ações que ADICIONAM investimento/exposição — só com base estatística. */
const SCALE_ACTIONS: ReadonlySet<RecommendationActionType> = new Set(["increase_budget", "resume"]);

/** Constrói o mapa `externalId → eligibility` a partir dos segmentos do brief. */
export function eligibilityByEntity(brief: AccountBrief): Map<string, DecisionEligibility> {
  const map = new Map<string, DecisionEligibility>();
  forEachEntity(brief, (e) => {
    if (e.eligibility) map.set(e.id, e.eligibility);
  });
  return map;
}

/**
 * Rebaixa recomendações de ESCALAR (aumentar budget / reativar) → `investigate`
 * quando a entidade-alvo não tem significância OU está em learning. Puro: não
 * remove (o dono ainda vê o sinal), só troca a ordem de ação + anota o porquê.
 */
export function guardScaleWithoutSignificance(
  output: AnalysisOutput,
  eligibility: ReadonlyMap<string, DecisionEligibility>,
): AnalysisOutput {
  const recommendations = output.recommendations.map((r) => {
    if (!SCALE_ACTIONS.has(r.actionType)) return r;
    const id = r.targetEntity?.externalId;
    const elig = id ? eligibility.get(id) : undefined;
    if (!elig || (elig.hasSignificance && !elig.inLearning)) return r;
    const why = elig.inLearning
      ? "em aprendizado (editada há pouco)"
      : `sem base estatística ainda (${elig.conversions} conversões)`;
    return {
      ...r,
      title: demotedTitle(r.title),
      actionType: "investigate" as RecommendationActionType,
      rationale: `${r.rationale}\n[guard] escalar → investigar: ${why}.`,
      budgetChangePct: null,
    };
  });
  return { ...output, recommendations };
}

// ─── Guard de "não matar em learning" (Fatia Bloco 2) ─────────────────────
// Simetria do guard de significância: assim como não se ESCALA sem base, não se
// MATA (pausa) o que ainda está em aprendizado — pausar descarta o aprendizado da
// Meta (veto do squad). EXCEÇÃO deliberada à regra "defensiva nunca é barrada":
// vale SÓ p/ recomendações de origem LLM (as de playbook não passam por aqui) e
// não toca zumbi (zumbi exige !inLearning). Playbook/guardrail/kill-switch/pedido
// explícito do dono continuam podendo pausar — não passam por este guard.

/** Ações que MATAM a entidade (descartam o aprendizado se em learning). */
const KILL_IN_LEARNING_ACTIONS: ReadonlySet<RecommendationActionType> = new Set(["pause"]);

/**
 * Rebaixa pausar → `investigate` quando o alvo está `inLearning`. Puro: não
 * remove (o dono vê o sinal), só troca a ordem de ação + anota o porquê. Sem
 * eligibility conhecida ou fora de learning → passa direto.
 */
export function guardKillWithoutMaturity(
  output: AnalysisOutput,
  eligibility: ReadonlyMap<string, DecisionEligibility>,
): AnalysisOutput {
  const recommendations = output.recommendations.map((r) => {
    if (!KILL_IN_LEARNING_ACTIONS.has(r.actionType)) return r;
    const id = r.targetEntity?.externalId;
    const elig = id ? eligibility.get(id) : undefined;
    if (!elig?.inLearning) return r;
    return {
      ...r,
      title: demotedTitle(r.title),
      actionType: "investigate" as RecommendationActionType,
      rationale: `${r.rationale}\n[guard] pausar → investigar: em aprendizado (editada há pouco) — dar tempo antes de matar (não descartar o aprendizado).`,
      budgetChangePct: null,
    };
  });
  return { ...output, recommendations };
}

// ─── Guard de tracking furado (Fatia Bloco 2 → pivô saúde) ────────────────
// Sobre o sinal de conta `detectTrackingHealth`: quando a medição de venda parece
// incompleta, REBAIXA (não só comenta) as recomendações que MATARIAM/CORTARIAM
// uma entidade por CPA de venda — mas só nas de base `target` (a venda É o
// objetivo medido ali); `proxy` já não é julgada por venda, então não é tocada.
// Decisão revista (ROADMAP `[ALTO]` "guard de tracking mais forte no caminho
// autônomo"): antes só anexava caveat (o dono decidia); numa conta que fecha
// fora da Meta (típico saúde) e opera em autonomia alta, um corte por CPA de
// venda catastrófico-mas-não-confiável passava sem barreira nenhuma — diferente
// dos guards de significância/learning acima, que sempre rebaixam. Vale sempre
// (não só no caminho autônomo — eco+confirma também se beneficia de ver
// `investigate` em vez de uma ação concreta já formada).

/** Ações que reduzem/matam investimento (onde o CPA de venda inflado engana). */
const KILL_ACTIONS: ReadonlySet<RecommendationActionType> = new Set(["pause", "decrease_budget"]);

/** Mapa `externalId → conversionBasis` a partir dos segmentos do brief. */
export function basisByEntity(brief: AccountBrief): Map<string, ConversionBasis> {
  const map = new Map<string, ConversionBasis>();
  forEachEntity(brief, (e) => {
    if (e.conversionBasis) map.set(e.id, e.conversionBasis);
  });
  return map;
}

/**
 * Rebaixa pausar/cortar → `investigate` nas entidades base `target` quando o
 * sinal de conta é suspeito, anexando a razão ao `rationale` (mesmo padrão dos
 * guards de significância/learning acima — nunca remove, o dono ainda vê o
 * sinal). Sem sinal suspeito → passa direto.
 */
export function guardTrackingCaveat(
  output: AnalysisOutput,
  basis: ReadonlyMap<string, ConversionBasis>,
  tracking: TrackingHealth | undefined,
): AnalysisOutput {
  if (!tracking?.suspect) return output;
  const recommendations = output.recommendations.map((r) => {
    if (!KILL_ACTIONS.has(r.actionType)) return r;
    const id = r.targetEntity?.externalId;
    if (!id || basis.get(id) !== "target") return r;
    return {
      ...r,
      title: demotedTitle(r.title),
      actionType: "investigate" as RecommendationActionType,
      rationale: `${r.rationale}\n[guard] pausar/cortar → investigar: a medição de vendas parece incompleta (${tracking.funnelStarted} conversas × ${tracking.trackedConversions} vendas rastreadas) — confirme pixel/CAPI antes de agir por CPA de venda.`,
      budgetChangePct: null,
    };
  });
  return { ...output, recommendations };
}

// ─── Guard de CPA marginal (pivô saúde, squad traffic-masters) ────────────
// "CPA médio mente. CPA marginal conta a verdade": o CPA médio/atual de uma entidade
// pode ainda bater a meta enquanto o incremento MAIS RECENTE já está mais caro — CPA
// médio dilui a piora recente. Aproximação disponível hoje: CPA da janela atual vs CPA
// da janela-baseline (a mesma comparação que já alimenta `deltaVsBaseline` no brief) —
// não ancorada ao instante exato da última mudança REAL de orçamento (isso exigiria
// cruzar `agent_tool_calls`/`insights_snapshots` por entidade; fast-follow quando essa
// precisão se justificar). Mesmo assim já pega o caso central: CPA piorando MESMO pra
// quem ainda bate a meta (`beatsTarget`), que os demais guards não cobrem (eles olham
// significância/learning, não tendência).

export interface MarginalCpaThresholds {
  /** alta (%) do CPA vs baseline a partir da qual rebaixa escalar → investigar. */
  readonly worsenPct: number;
}

export const DEFAULT_MARGINAL_CPA_THRESHOLDS: MarginalCpaThresholds = { worsenPct: 20 };

/** `%` de alta do CPA (atual vs baseline; positivo = piorou) por `externalId`. `undefined`
 *  quando falta CPA atual ou delta (não penaliza por falta de dado — mesmo espírito de
 *  `eligibilityByEntity`/`basisByEntity`). */
export function marginalCpaRiseByEntity(brief: AccountBrief): Map<string, number | undefined> {
  const map = new Map<string, number | undefined>();
  forEachEntity(brief, (e) => {
    const cpa = e.metrics.cpa;
    const delta = e.deltaVsBaseline.cpa;
    if (typeof cpa !== "number" || typeof delta !== "number") {
      map.set(e.id, undefined);
      return;
    }
    const baseline = cpa - delta;
    map.set(e.id, baseline > 0 ? ((cpa - baseline) / baseline) * 100 : undefined);
  });
  return map;
}

/**
 * Rebaixa recomendações de ESCALAR quando o CPA marginal da entidade-alvo piorou acima
 * do limiar — mesmo que o CPA médio/atual ainda pareça bom o suficiente pra bater a meta
 * (é exatamente esse caso que o guard de significância não pega). Puro: não remove, só
 * troca a ordem de ação + anota o porquê. Sem sinal (undefined) → passa direto.
 */
export function guardScaleWithWorseningMarginalCpa(
  output: AnalysisOutput,
  marginalRisePct: ReadonlyMap<string, number | undefined>,
  t: MarginalCpaThresholds,
): AnalysisOutput {
  // config malformada (worsenPct não-finito/≤0) → guard inerte: nunca rebaixa (nunca
  // confia cegamente num limiar quebrado, já que este guard barra escrita autônoma de
  // budget). Sem esta guarda, `rise < NaN` seria sempre false → rebaixaria QUALQUER escala.
  if (!Number.isFinite(t.worsenPct) || t.worsenPct <= 0) return output;
  const recommendations = output.recommendations.map((r) => {
    if (!SCALE_ACTIONS.has(r.actionType)) return r;
    const id = r.targetEntity?.externalId;
    const rise = id ? marginalRisePct.get(id) : undefined;
    if (rise === undefined || rise < t.worsenPct) return r;
    return {
      ...r,
      title: demotedTitle(r.title),
      actionType: "investigate" as RecommendationActionType,
      rationale: `${r.rationale}\n[guard] escalar → investigar: CPA marginal piorando (+${rise.toFixed(0)}% vs período anterior) — o CPA médio pode parecer bom, mas o incremento mais recente já está mais caro.`,
      budgetChangePct: null,
    };
  });
  return { ...output, recommendations };
}

// ─── Guard de teto de escala por audiência (Fase 4, pivô saúde) ───────────
// "Antes de recomendar aumentar orçamento, checa se a AUDIÊNCIA aguenta mais gasto sem
// saturar." Reativo e com IO (chamada à Meta) FORA deste guard — o worker resolve
// `deliveryEstimate` só p/ as entidades que JÁ têm proposta de escalar NESTE run (nunca
// varre a conta à toa) e monta o mapa abaixo; o guard em si é PURO, só decide.

/** Insumo já resolvido por entidade (IO já feito pelo worker). */
export interface AudienceHeadroom {
  /** alcance mensal (MAU) — ausente = a plataforma ainda não estimou (público novo/lookalike);
   *  guard passa direto (honesto: sem dado, não assume saturado). */
  readonly monthlyReach?: number;
  /** impressões mensais no ritmo ATUAL (extrapolado da janela de análise). */
  readonly currentMonthlyImpressions: number;
  /** teto de frequência saudável resolvido (mesmo cálculo por-estágio de `enrichEntitiesQuality`). */
  readonly frequencyCap: number;
}

export interface AudienceCeilingThresholds {
  /** fração do teto (MAU × frequencyCap) considerada "perto de saturar" — a partir daqui rebaixa. */
  readonly nearSaturationRatio: number;
}

export const DEFAULT_AUDIENCE_CEILING_THRESHOLDS: AudienceCeilingThresholds = { nearSaturationRatio: 0.8 };

/**
 * Rebaixa ESCALAR (aumentar orçamento / reativar) → `investigate` quando o público
 * (MAU × teto de frequência saudável) já está perto do limite de impressões sustentáveis —
 * mais orçamento tenderia a aumentar FREQUÊNCIA (mesma gente vendo mais vezes), não
 * alcançar gente nova. Puro: não remove, só troca a ordem de ação + anota o porquê.
 */
export function guardAudienceScaleCeiling(
  output: AnalysisOutput,
  headroomByEntity: ReadonlyMap<string, AudienceHeadroom>,
  t: AudienceCeilingThresholds,
): AnalysisOutput {
  const recommendations = output.recommendations.map((r) => {
    if (!SCALE_ACTIONS.has(r.actionType)) return r;
    const id = r.targetEntity?.externalId;
    const headroom = id ? headroomByEntity.get(id) : undefined;
    if (!headroom || headroom.monthlyReach === undefined) return r;
    const cap = headroom.monthlyReach * headroom.frequencyCap;
    if (cap <= 0) return r;
    const ratio = headroom.currentMonthlyImpressions / cap;
    if (ratio < t.nearSaturationRatio) return r;
    return {
      ...r,
      title: demotedTitle(r.title),
      actionType: "investigate" as RecommendationActionType,
      rationale: `${r.rationale}\n[guard] escalar → investigar: o público (~${Math.round(headroom.monthlyReach)} pessoas/mês) já está perto do teto de frequência saudável — mais orçamento tende a aumentar FREQUÊNCIA (mesma gente vendo mais vezes), não alcançar gente nova.`,
      budgetChangePct: null,
    };
  });
  return { ...output, recommendations };
}

// ─── Helpers compartilhados pelos guards acima ────────────────────────────

/** Itera as 3 camadas do brief (campanha/adset/anúncio) — evita repetir o `for`
 *  triplo em cada `xByEntity` (CLAUDE.md §13 "duplicou 3x → extrai"). */
function forEachEntity(brief: AccountBrief, fn: (e: EntitySummary) => void): void {
  for (const level of [brief.segments.campaigns, brief.segments.adsets, brief.segments.ads]) {
    for (const e of level) fn(e);
  }
}

const INVESTIGATE_TITLE_PREFIX = "Investigar: ";

/** Prefixa o título quando um guard rebaixa a ação pra `investigate` — sem isso o card
 *  mostraria um headline ("Escalar campanha X") desalinhado da ação real (CLAUDE.md
 *  §13 UX: "erro/decisão = o que aconteceu + o que fazer"). Idempotente por construção:
 *  cada guard só entra nesse ramo quando `actionType` AINDA está no seu Set de ações-alvo
 *  (`SCALE_ACTIONS`/`KILL_ACTIONS`/`KILL_IN_LEARNING_ACTIONS`) — uma vez rebaixado por um
 *  guard anterior, os seguintes já retornam cedo e nunca reprocessam o título. */
function demotedTitle(title: string): string {
  return title.startsWith(INVESTIGATE_TITLE_PREFIX) ? title : `${INVESTIGATE_TITLE_PREFIX}${title}`;
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
