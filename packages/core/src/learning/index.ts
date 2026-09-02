// Aprendizado contínuo — camada PURA (sem IO, testável sem mock). Detecta padrões
// recorrentes no histórico de análise (observacional, vale mesmo sem ação aplicada),
// calcula confiança (nasce baixa; só confirmação humana ou outcome medido de ação
// nossa passam do teto observacional) e prepara a candidata para o redator LLM (que
// SÓ traduz — nunca inventa lição). A curadoria (dedupe/merge/decay/contradição) e a
// medição de outcome de ações nossas entram nas subfatias seguintes reusando estes tipos.

import type { ActionType, BriefLesson, HealthSignal, LessonConfidenceTier, LessonOrigin, PerformanceTier } from "@trafego/shared";

// ─── Taxonomia (fonte única do tipo) ──────────────────────────────────────

/** Tipo de lição. Mapeia para `memoryType` do DB: `fact`→`fact`, `calibration`→`past_action`. */
export type LessonKind = "fact" | "calibration";

/** Mapa único LessonKind ↔ `memory_type` do DB (fonte única — evita drift em 3 lugares). */
export const MEMORY_TYPE_BY_KIND: Record<LessonKind, "fact" | "past_action"> = { fact: "fact", calibration: "past_action" };
/** Os `memory_type`s que são LIÇÕES de aprendizado (fact/past_action) — derivado da fonte
 *  única acima. Reusado por todo filtro `type in (...)` de aprendizado (casca api/worker),
 *  em vez de repetir o literal `["fact","past_action"]` (§13 sem string mágica / reuso-1º). */
export const LEARNING_MEMORY_TYPES = Object.values(MEMORY_TYPE_BY_KIND) as readonly ("fact" | "past_action")[];
export function lessonKindFromMemoryType(type: string): LessonKind {
  return type === "past_action" ? "calibration" : "fact";
}

/** Escopo hierárquico — a fundação usa só `entity`/`account`; `org`/`global` já ficam
 *  no tipo para subir a cross-conta/cross-org depois sem reescrever. */
export const LESSON_SCOPES = ["entity", "account", "org", "global"] as const;
export type LessonScope = (typeof LESSON_SCOPES)[number];

/** Dimensão do que a lição fala — a coluna vertebral da chave semântica (dedupe). */
export const LESSON_DIMENSIONS = [
  "pacing",
  "creative",
  "audience",
  "tracking",
  "budget",
  "significance",
  "conversion",
  "other",
] as const;
export type LessonDimension = (typeof LESSON_DIMENSIONS)[number];

/** Direção da lição — `lower` = mais cauteloso/cortar; `raise` = escalar/ampliar; `neutral` = ressalva. */
export const LESSON_DIRECTIONS = ["raise", "lower", "neutral"] as const;
export type LessonDirection = (typeof LESSON_DIRECTIONS)[number];

/** De onde veio a lição — determina o teto de confiança sem confirmação humana.
 *  O tipo `LessonOrigin` é canônico em @trafego/shared; a tupla espelha (satisfies). */
export const LESSON_ORIGINS = [
  "our_action",
  "observational",
  "human_feedback",
  "human_manual",
] as const satisfies readonly LessonOrigin[];

/** Chave semântica — dedupe/merge: nova observação da MESMA chave reforça, não cria linha. */
export interface SemanticKey {
  readonly scope: LessonScope;
  readonly dimension: LessonDimension;
  readonly direction: LessonDirection;
  /** id externo da entidade quando `scope === "entity"`. */
  readonly subjectId?: string;
}

/** String canônica determinística da chave (materializada em `agent_memory.semantic_key`). */
export function lessonKeyOf(key: SemanticKey): string {
  const base = `${key.scope}:${key.dimension}:${key.direction}`;
  return key.subjectId ? `${base}:${key.subjectId}` : base;
}

// ─── Confiança ────────────────────────────────────────────────────────────

/** Teto de confiança de uma lição SÓ observacional (nunca vira "confirmada" sozinha). */
export const OBSERVATIONAL_CONFIDENCE_CAP = 0.6;
/** Teto de confiança quando há outcome MEDIDO de uma ação nossa (atribuição forte). */
export const MEASURED_CONFIDENCE_CAP = 0.85;
/** A partir daqui a lição entra no prompt do analista (rotulada). Observação sozinha não chega. */
export const PROMPT_CONFIDENCE_THRESHOLD = 0.7;
/** Confiança após confirmação humana explícita. */
export const CONFIRMED_CONFIDENCE = 0.9;
/** Quanto uma nova evidência aproxima a confiança do teto (ganho decrescente). */
const CONFIDENCE_APPROACH_RATE = 0.5;
/** Fator de queda quando um outcome recente contradiz a lição. */
const CONTRADICTION_DECAY = 0.5;

/** Evento que move a confiança de uma lição. */
export type ConfidenceEvent =
  | { readonly type: "observe"; readonly occurrenceRatio: number; readonly origin: LessonOrigin }
  | { readonly type: "measured"; readonly positive: boolean }
  | { readonly type: "confirm" }
  | { readonly type: "contradict" };

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

function originCap(origin: LessonOrigin): number {
  return origin === "our_action" ? MEASURED_CONFIDENCE_CAP : OBSERVATIONAL_CONFIDENCE_CAP;
}

/** Aproxima `base` de `cap` proporcional à força da evidência (ganho decrescente). */
function approach(base: number, cap: number, strength: number): number {
  if (base >= cap) return base;
  return clamp01(base + (cap - base) * CONFIDENCE_APPROACH_RATE * clamp01(strength));
}

/**
 * Nova confiança da lição após um evento. Nasce baixa; observação pura satura no
 * `OBSERVATIONAL_CONFIDENCE_CAP` (< limiar do prompt → só influencia via guard);
 * confirmação humana e outcome medido são as únicas vias acima disso.
 */
export function computeConfidence(prev: number | null, event: ConfidenceEvent): number {
  const base = prev ?? 0;
  switch (event.type) {
    case "observe":
      return approach(base, originCap(event.origin), event.occurrenceRatio);
    case "measured":
      return event.positive
        ? approach(base, MEASURED_CONFIDENCE_CAP, 1)
        : clamp01(base * CONTRADICTION_DECAY);
    case "confirm":
      return clamp01(Math.max(base, CONFIRMED_CONFIDENCE));
    case "contradict":
      return clamp01(base * CONTRADICTION_DECAY);
  }
}

/** Selo amigável (a UI traduz para rótulo acentuado). Tipo canônico em @trafego/shared. */
export const LESSON_CONFIDENCE_TIERS = [
  "explorando",
  "provavel",
  "confirmado",
] as const satisfies readonly LessonConfidenceTier[];

const PROVAVEL_THRESHOLD = 0.5;
const CONFIRMADO_THRESHOLD = 0.85;

export function confidenceTier(confidence: number, confirmedByHuman: boolean): LessonConfidenceTier {
  if (confirmedByHuman || confidence >= CONFIRMADO_THRESHOLD) return "confirmado";
  if (confidence >= PROVAVEL_THRESHOLD) return "provavel";
  return "explorando";
}

// ─── Candidata + evidência ────────────────────────────────────────────────

/** Rótulo de máquina do padrão detectado — o redator traduz, nunca inventa. */
export type FactPattern = "persistent_zombie" | "persistent_underperformer" | "recurring_health_signal" | "recurring_tracking_suspect";

/** Padrão de CALIBRAÇÃO (S4) — o que a medição de outcome de uma ação NOSSA ensinou. */
export type CalibrationPattern = "scale_backfired" | "cut_worked";

/** Padrão de PRIOR DE CONTA (v3) — destilado de outcome medido em ≥K entidades distintas. */
export type AccountPriorPattern = "account_cut_pays" | "account_scale_backfires" | "account_scale_pays";

/** Qualquer padrão de lição (observacional + calibração + prior de conta). */
export type LessonPattern = FactPattern | CalibrationPattern | AccountPriorPattern;

export interface LessonEvidence {
  readonly pattern: LessonPattern;
  /** nº de runs/observações que corroboram (observacional) ou 1 (calibração medida). */
  readonly occurrences: number;
  readonly totalRuns: number;
  readonly subjectName?: string;
  /** sinal de saúde recorrente, quando `pattern === "recurring_health_signal"`. */
  readonly healthSignal?: HealthSignal;
}

/** Candidata a lição — estruturada; o `content` (frase PT) é preenchido pelo redator depois. */
export interface LessonCandidate {
  readonly kind: LessonKind;
  readonly key: SemanticKey;
  readonly origin: LessonOrigin;
  readonly confidence: number;
  readonly evidence: LessonEvidence;
}

// ─── Detecção observacional (S1) ──────────────────────────────────────────

/** Projeção mínima de uma campanha num run (do `agent_runs.metrics_snapshot`). */
export interface RunCampaignPattern {
  readonly externalId: string;
  readonly name: string;
  readonly tier?: PerformanceTier;
  readonly healthSignals?: readonly HealthSignal[];
}

/** Um run de análise para fins de aprendizado — histórico por-run (não a última só). */
export interface RunLearningSnapshot {
  readonly runId: string;
  readonly at: string;
  readonly campaigns: readonly RunCampaignPattern[];
  /** medição de conversão suspeita naquele run (do `metrics_snapshot.trackingHealth`). */
  readonly trackingSuspect?: boolean;
}

export interface FactDetectionConfig {
  /** mínimo de runs no histórico p/ arriscar um padrão (evita ruído de 1-2 análises). */
  readonly minRuns: number;
  /** fração dos runs que precisa exibir o padrão p/ ele valer. */
  readonly minOccurrenceRatio: number;
}

export const DEFAULT_FACT_DETECTION: FactDetectionConfig = { minRuns: 3, minOccurrenceRatio: 0.6 };

export interface DetectFactInput {
  /** runs do agente, mais antigo → mais novo. */
  readonly runs: readonly RunLearningSnapshot[];
  readonly config?: Partial<FactDetectionConfig>;
}

/**
 * Destila padrões RECORRENTES de CONTA do histórico de análise → candidatas `fact`. Puro.
 * v3: só o **tracking-suspeito recorrente** (nível conta) — os padrões por-ENTIDADE
 * (zumbi/underperformer/fadiga) foram removidos por serem redundantes com a análise stateless
 * (que já recalcula e recomenda a cada run) e inertes (saturam abaixo do limiar do prompt). O
 * aprendizado de conta que vale vem de outcome MEDIDO (`distillAccountPriors`) e de padrão
 * TEMPORAL do histórico (detectores temporais) — não de re-observar o estado atual por campanha.
 */
export function detectFactCandidates(input: DetectFactInput): LessonCandidate[] {
  const cfg = { ...DEFAULT_FACT_DETECTION, ...input.config };
  const runs = input.runs;
  if (runs.length < cfg.minRuns) return [];

  const out: LessonCandidate[] = [];
  const observe = (occurrenceRatio: number): number =>
    computeConfidence(null, { type: "observe", occurrenceRatio, origin: "observational" });

  // ── Tracking suspeito recorrente (nível CONTA) — a ressalva de medição que persiste ──
  const suspectRuns = runs.filter((r) => r.trackingSuspect === true).length;
  if (suspectRuns / runs.length >= cfg.minOccurrenceRatio) {
    out.push({
      kind: "fact",
      key: { scope: "account", dimension: "tracking", direction: "neutral" },
      origin: "observational",
      confidence: observe(suspectRuns / runs.length),
      evidence: { pattern: "recurring_tracking_suspect", occurrences: suspectRuns, totalRuns: runs.length },
    });
  }

  return out;
}

// ─── Sinal A: medição de outcome de ação NOSSA + calibração (S4) ───────────

export type MeasuredOutcome = "positive" | "negative" | "neutral";

/** Janela agregada de métricas (entidade ou conta) antes/depois de uma ação. */
export interface OutcomeWindow {
  readonly spend: number;
  /** conversões de negócio/entidade — o "resultado" que importa. */
  readonly results: number;
  /** CPA medido (opcional; derivado de spend/results quando ausente). */
  readonly cpa?: number;
}

export interface OutcomeThresholds {
  /** variação de CPA (fração) dentro disso = "manteve" (nem melhora nem piora). */
  readonly cpaTolerance: number;
  /** tolerância MAIOR p/ o veredito no nível da CONTA (pausa): o CPA da conta soma
   *  conversões de metas heterogêneas (campanhas com objetivos diferentes) → só um efeito
   *  GRANDE conta, senão neutro (evita lição espúria de um total apples-and-oranges). */
  readonly accountCpaTolerance: number;
  /** resultados mínimos numa janela p/ o CPA valer (senão neutro/indeterminado). */
  readonly minResults: number;
}
export const DEFAULT_OUTCOME_THRESHOLDS: OutcomeThresholds = { cpaTolerance: 0.15, accountCpaTolerance: 0.4, minResults: 3 };

export interface ComputeOutcomeInput {
  readonly actionType: ActionType;
  /** params da ação (ex: adjust_budget `mode`, set_status `status`). */
  readonly params?: Readonly<Record<string, unknown>>;
  /** janela da ENTIDADE antes/depois da ação. */
  readonly entityPre: OutcomeWindow;
  readonly entityPost: OutcomeWindow;
  /** janela da CONTA antes/depois — necessária p/ medir PAUSA (a entidade zera). */
  readonly accountPre?: OutcomeWindow;
  readonly accountPost?: OutcomeWindow;
  readonly thresholds?: OutcomeThresholds;
}

function cpaOf(w: OutcomeWindow): number | undefined {
  if (typeof w.cpa === "number" && w.cpa > 0) return w.cpa;
  return w.results > 0 ? w.spend / w.results : undefined;
}

/** Efeito da ação p/ a medição — normaliza os vários jeitos de expressar a mesma coisa. */
type ActionEffect = "pause" | "resume" | "budget_up" | "budget_down" | "other";

function actionEffect(actionType: ActionType, params?: Readonly<Record<string, unknown>>): ActionEffect {
  if (actionType === "pause_entity") return "pause";
  if (actionType === "resume_entity") return "resume";
  if (actionType === "set_status") {
    const s = params?.status;
    if (s === "paused" || s === "PAUSED" || s === "archived" || s === "ARCHIVED") return "pause";
    if (s === "active" || s === "ACTIVE") return "resume";
    return "other";
  }
  if (actionType === "adjust_budget") {
    const mode = params?.mode;
    if (mode === "increase") return "budget_up";
    if (mode === "decrease") return "budget_down";
    return "other"; // 'set' (absoluto) — sem o orçamento anterior não dá p/ inferir direção.
  }
  return "other";
}

/** Compara CPA de duas janelas → melhora/mantém = positivo; piora = negativo; sem base = neutro. */
function cpaVerdict(pre: OutcomeWindow, post: OutcomeWindow, t: OutcomeThresholds): MeasuredOutcome {
  if (pre.results < t.minResults || post.results < t.minResults) return "neutral";
  const cpaPre = cpaOf(pre);
  const cpaPost = cpaOf(post);
  if (cpaPre === undefined || cpaPost === undefined) return "neutral";
  const delta = (cpaPost - cpaPre) / cpaPre;
  if (delta > t.cpaTolerance) return "negative";
  return "positive"; // melhorou ou manteve dentro da tolerância
}

/** É uma ação que zera a entidade (mede-se no nível da CONTA)? */
function isPause(actionType: ActionType, params?: Readonly<Record<string, unknown>>): boolean {
  return actionEffect(actionType, params) === "pause";
}

/**
 * Outcome MEDIDO de uma ação nossa — pelo EFEITO da ação, no NÍVEL certo. Honesto:
 * `neutral` (indeterminado) quando não dá p/ concluir (nunca declara sucesso que não mede).
 *  - pausa → mede a CONTA (a entidade zera; o efeito é a verba realocada);
 *  - ajuste de orçamento → mede o CPA da PRÓPRIA entidade;
 *  - reativação → a entidade voltou a entregar resultado?
 */
export function computeOutcome(input: ComputeOutcomeInput): MeasuredOutcome {
  const t = input.thresholds ?? DEFAULT_OUTCOME_THRESHOLDS;
  const effect = actionEffect(input.actionType, input.params);
  if (effect === "pause") {
    if (!input.accountPre || !input.accountPost) return "neutral";
    // veredito no nível da conta usa a tolerância MAIOR (metas mistas → só efeito grande conta).
    return cpaVerdict(input.accountPre, input.accountPost, { ...t, cpaTolerance: t.accountCpaTolerance });
  }
  if (effect === "budget_up" || effect === "budget_down") {
    return cpaVerdict(input.entityPre, input.entityPost, t);
  }
  if (effect === "resume") {
    if (input.entityPost.results >= t.minResults) return "positive";
    if (input.entityPost.spend > 0 && input.entityPost.results === 0) return "negative";
    return "neutral";
  }
  return "neutral";
}

/** Ações que ADICIONAM investimento/exposição (escala) — espelha SCALE_ACTIONS do guard. */
function isScaleAction(actionType: ActionType, params?: Readonly<Record<string, unknown>>): boolean {
  const effect = actionEffect(actionType, params);
  return effect === "resume" || effect === "budget_up";
}

export interface CalibrationInput {
  readonly actionType: ActionType;
  readonly params?: Readonly<Record<string, unknown>>;
  readonly outcome: MeasuredOutcome;
  readonly subjectId: string;
  readonly subjectName?: string;
}

/**
 * Traduz um outcome medido numa candidata de CALIBRAÇÃO (só os casos que viram CAUTELA
 * acionável — casam com o guard assimétrico e o prompt):
 *  - ESCALA que deu errado → "escalar aqui piora" (pacing/lower);
 *  - CORTE (pausa/reduzir) que deu certo → "cortar aqui ajuda" (budget/lower).
 * Confiança nasce forte (atribuição de ação nossa). Demais combinações → null (o outcome
 * pode CONTRADIZER uma lição existente — isso é tratado fora, no serviço).
 */
export function detectCalibrationCandidate(input: CalibrationInput): LessonCandidate | null {
  const measuredConfidence = computeConfidence(null, { type: "measured", positive: true });
  const scale = isScaleAction(input.actionType, input.params);
  const cut = isPause(input.actionType, input.params) || actionEffect(input.actionType, input.params) === "budget_down";

  if (scale && input.outcome === "negative") {
    return {
      kind: "calibration",
      key: { scope: "entity", dimension: "pacing", direction: "lower", subjectId: input.subjectId },
      origin: "our_action",
      confidence: measuredConfidence,
      evidence: { pattern: "scale_backfired", occurrences: 1, totalRuns: 1, ...(input.subjectName ? { subjectName: input.subjectName } : {}) },
    };
  }
  if (cut && input.outcome === "positive") {
    return {
      kind: "calibration",
      key: { scope: "entity", dimension: "budget", direction: "lower", subjectId: input.subjectId },
      origin: "our_action",
      confidence: measuredConfidence,
      evidence: { pattern: "cut_worked", occurrences: 1, totalRuns: 1, ...(input.subjectName ? { subjectName: input.subjectName } : {}) },
    };
  }
  return null;
}

/** Config mínima de uma entidade num instante — p/ detectar mudança manual (S4). */
export interface EntityConfigDelta {
  readonly status: string;
  readonly dailyBudgetMinor?: number;
  readonly lifetimeBudgetMinor?: number;
}

/** Variação mínima de orçamento (fração) p/ contar como mudança MATERIAL. */
export const MANUAL_BUDGET_CHANGE_MIN_PCT = 0.15;

// Todo status inativo (espelha EntityStatus não-active): pausado/arquivado/DELETADO.
const INACTIVE_STATUSES = new Set(["paused", "archived", "deleted", "PAUSED", "ARCHIVED", "DELETED"]);
function isActive(status: string): boolean {
  return !INACTIVE_STATUSES.has(status);
}

/**
 * Traduz uma mudança de config (prev→curr) numa AÇÃO sintética, p/ medir o outcome de uma
 * mudança que o gestor fez NA MÃO na Meta (fora das nossas ações). Null = sem mudança
 * material. Pausa/reativação por status; escalar/reduzir por orçamento diário.
 */
export function manualChangeToAction(
  prev: EntityConfigDelta,
  curr: EntityConfigDelta,
): { actionType: ActionType; params: Record<string, unknown> } | null {
  if (isActive(prev.status) && !isActive(curr.status)) return { actionType: "pause_entity", params: {} };
  if (!isActive(prev.status) && isActive(curr.status)) return { actionType: "resume_entity", params: {} };
  const pb = prev.dailyBudgetMinor;
  const cb = curr.dailyBudgetMinor;
  if (typeof pb === "number" && pb > 0 && typeof cb === "number") {
    const delta = (cb - pb) / pb;
    if (delta >= MANUAL_BUDGET_CHANGE_MIN_PCT) return { actionType: "adjust_budget", params: { mode: "increase" } };
    if (delta <= -MANUAL_BUDGET_CHANGE_MIN_PCT) return { actionType: "adjust_budget", params: { mode: "decrease" } };
  }
  return null;
}

/**
 * Quando um outcome CONTRADIZ a conclusão de uma lição existente (ex: escalamos e deu
 * CERTO, apesar de uma lição dizer "não escale aqui"; ou cortamos e piorou, apesar de
 * "cortar aqui ajuda") — a chave da lição a enfraquecer. Null = nada a contradizer.
 */
export function contradictedLessonKey(input: CalibrationInput): SemanticKey | null {
  const scale = isScaleAction(input.actionType, input.params);
  const cut = isPause(input.actionType, input.params) || actionEffect(input.actionType, input.params) === "budget_down";
  if (scale && input.outcome === "positive") {
    // escalar deu certo → enfraquece uma eventual "não escale aqui".
    return { scope: "entity", dimension: "pacing", direction: "lower", subjectId: input.subjectId };
  }
  if (cut && input.outcome === "negative") {
    // cortar piorou → enfraquece uma eventual "cortar aqui ajuda".
    return { scope: "entity", dimension: "budget", direction: "lower", subjectId: input.subjectId };
  }
  return null;
}

// ─── Prior de CONTA: classificação de evidência + destilação cross-seccional (v3) ─────

/** Entrada de evidência: a (dimensão, direção) do prior de conta que o outcome SUSTENTA
 *  (supports=true) ou CONTRADIZ (supports=false). */
export interface AccountEvidenceEntry {
  readonly dimension: LessonDimension;
  readonly direction: LessonDirection;
  readonly supports: boolean;
}

/**
 * Classifica um outcome MEDIDO de (ação, resultado) nas entradas de evidência que gera — a
 * (dimensão, direção) do prior de conta que sustenta e a que contradiz. Vazio quando neutro/
 * indeterminado (nunca vira evidência). Puro. É o que popula o ledger `learning_evidence`.
 */
export function classifyOutcomeEvidence(input: CalibrationInput): AccountEvidenceEntry[] {
  if (input.outcome === "neutral") return [];
  const scale = isScaleAction(input.actionType, input.params);
  const cut = isPause(input.actionType, input.params) || actionEffect(input.actionType, input.params) === "budget_down";
  const positive = input.outcome === "positive";
  if (cut) return [{ dimension: "budget", direction: "lower", supports: positive }]; // corte: positivo sustenta "cortar compensa"
  if (scale) {
    // escala: positivo sustenta "escalar compensa" (raise) e contradiz "escalar piora" (lower); negativo o inverso.
    return positive
      ? [{ dimension: "pacing", direction: "raise", supports: true }, { dimension: "pacing", direction: "lower", supports: false }]
      : [{ dimension: "pacing", direction: "lower", supports: true }, { dimension: "pacing", direction: "raise", supports: false }];
  }
  return [];
}

/** Uma linha do ledger de evidência (o que o repo entrega à destilação). */
export interface AccountEvidenceRow extends AccountEvidenceEntry {
  readonly entityId: string;
}

export interface DistillAccountConfig {
  /** mínimo de entidades DISTINTAS sustentando p/ nascer um prior de conta. */
  readonly minEntities: number;
}
export const DEFAULT_ACCOUNT_MIN_ENTITIES = 3;

const ACCOUNT_PATTERN: Partial<Record<string, AccountPriorPattern>> = {
  "budget:lower": "account_cut_pays",
  "pacing:lower": "account_scale_backfires",
  "pacing:raise": "account_scale_pays",
};

/**
 * Destila priors de CONTA do ledger (cross-seccional): por (dimensão, direção), conta
 * ENTIDADES DISTINTAS que sustentam (S) e que contradizem (O); emite o prior quando
 * `S ≥ minEntities` **E** `S > O` (direção domina). Confiança escala com S (teto medido 0,85 —
 * um prior de ≥3 entidades nasce ≥0,7, forte o bastante p/ o prompt). Puro.
 */
export function distillAccountPriors(rows: readonly AccountEvidenceRow[], cfg: DistillAccountConfig): LessonCandidate[] {
  const groups = new Map<string, { support: Set<string>; oppose: Set<string> }>();
  for (const r of rows) {
    const key = `${r.dimension}:${r.direction}`;
    const g = groups.get(key) ?? { support: new Set<string>(), oppose: new Set<string>() };
    (r.supports ? g.support : g.oppose).add(r.entityId);
    groups.set(key, g);
  }
  const out: LessonCandidate[] = [];
  for (const [key, g] of groups) {
    const S = g.support.size;
    const O = g.oppose.size;
    const pattern = ACCOUNT_PATTERN[key];
    if (!pattern || S < cfg.minEntities || S <= O) continue;
    const [dimension, direction] = key.split(":") as [LessonDimension, LessonDirection];
    let confidence = 0;
    for (let i = 0; i < S; i++) confidence = computeConfidence(confidence, { type: "measured", positive: true });
    out.push({
      kind: "calibration",
      key: { scope: "account", dimension, direction },
      origin: "our_action",
      confidence,
      evidence: { pattern, occurrences: S, totalRuns: S + O },
    });
  }
  return out;
}

// ─── Calibração paramétrica: proposta de limiar (S6) ──────────────────────

/** A partir desta confiança uma lição de calibração pode PROPOR ajustar um limiar. */
export const THRESHOLD_PROPOSAL_CONFIDENCE = 0.8;

/**
 * Proposta de ajuste de UM limiar de `model_config.quality` — o INTENT (qual limiar, quanto
 * apertar, piso) + a frase de COMPORTAMENTO mostrada ao usuário (nunca jargão de limiar). O
 * valor concreto é calculado no aceite a partir do limiar ATUAL do agente (`nextThresholdValue`).
 */
export interface ThresholdProposal {
  readonly threshold: string;
  /** fração de redução aplicada ao valor atual (aperta o limiar). */
  readonly stepPct: number;
  readonly minValue: number;
  /** frase em linguagem de comportamento p/ o card da UI (não fala em "limiar"). */
  readonly behaviorLabel: string;
}

// mapeia a DIMENSÃO da lição de calibração → limiar de qualidade a propor. Só calibração;
// só estas duas dimensões têm um limiar de comportamento claro hoje. Ambas na direção `lower`
// (mais conservador): cortar desperdício mais cedo / ser mais rigoroso antes de escalar.
const CALIBRATION_THRESHOLD_PROPOSAL: Partial<Record<LessonDimension, ThresholdProposal>> = {
  pacing: {
    threshold: "marginalCpaWorsenPct",
    stepPct: 0.25,
    minValue: 5,
    behaviorLabel: "passar a ser mais rigoroso com a piora de custo antes de escalar aqui",
  },
  budget: {
    threshold: "zombieMinSpend",
    stepPct: 0.25,
    minValue: 1,
    behaviorLabel: "passar a cortar desperdício mais cedo nesta conta",
  },
};

/**
 * Proposta de limiar para uma lição de calibração (ou null). **Só conservador:** propõe apenas
 * na direção `lower` (apertar = mais cauteloso). Um prior AGRESSIVO (`account_scale_pays`,
 * direção `raise`) NUNCA vira proposta de limiar — a agressividade influencia só via prompt,
 * limitada pelo guardrail (que o aprendizado nunca toca). Só `calibration`.
 */
export function proposalForCalibration(kind: LessonKind, dimension: LessonDimension, direction: LessonDirection): ThresholdProposal | null {
  if (kind !== "calibration" || direction !== "lower") return null;
  return CALIBRATION_THRESHOLD_PROPOSAL[dimension] ?? null;
}

/** Novo valor do limiar no aceite: reduz `current` por `stepPct`, respeitando o piso. Puro. */
export function nextThresholdValue(current: number, proposal: ThresholdProposal): number {
  const reduced = current * (1 - proposal.stepPct);
  return Math.max(proposal.minValue, Math.round(reduced * 100) / 100);
}

// ─── Redator (LLM só traduz a candidata; fallback determinístico) ──────────

export interface RedactorInput {
  readonly kind: LessonKind;
  readonly dimension: LessonDimension;
  readonly direction: LessonDirection;
  readonly scope: LessonScope;
  readonly pattern: LessonPattern;
  readonly occurrences: number;
  readonly totalRuns: number;
  readonly subjectName?: string;
  readonly healthSignal?: HealthSignal;
}

export function describeLessonForRedactor(candidate: LessonCandidate): RedactorInput {
  return {
    kind: candidate.kind,
    dimension: candidate.key.dimension,
    direction: candidate.key.direction,
    scope: candidate.key.scope,
    pattern: candidate.evidence.pattern,
    occurrences: candidate.evidence.occurrences,
    totalRuns: candidate.evidence.totalRuns,
    ...(candidate.evidence.subjectName ? { subjectName: candidate.evidence.subjectName } : {}),
    ...(candidate.evidence.healthSignal ? { healthSignal: candidate.evidence.healthSignal } : {}),
  };
}

const HEALTH_SIGNAL_LABEL: Record<HealthSignal, string> = {
  creative_fatigue: "fadiga de criativo",
  audience_saturation: "saturação de público",
  low_volume: "baixo volume",
  weak_creative: "criativo fraco",
  platform_quality_below_average: "qualidade abaixo da média",
  weak_hook_retention: "retenção baixa nos primeiros segundos",
};

/**
 * Texto de fallback determinístico (PT) — usado quando o redator LLM está indisponível
 * ou falha. Garante que o loop de aprendizado funciona mesmo sem LLM (E2E determinístico).
 */
export function fallbackLessonText(r: RedactorInput): string {
  const alvo = r.subjectName ? `"${r.subjectName}"` : "esta conta";
  switch (r.pattern) {
    case "persistent_zombie":
      return `A campanha ${alvo} aparece como desperdício (gasta sem resultado) na maioria das análises recentes — candidata a cortar verba.`;
    case "persistent_underperformer":
      return `A campanha ${alvo} vem entregando abaixo do esperado de forma consistente nas análises recentes.`;
    case "recurring_health_signal":
      return `A campanha ${alvo} mostra ${r.healthSignal ? HEALTH_SIGNAL_LABEL[r.healthSignal] : "um sinal de saúde"} de forma recorrente nas análises recentes.`;
    case "recurring_tracking_suspect":
      return `A medição de conversão desta conta aparece suspeita de forma recorrente — trate os números de conversão com cautela.`;
    case "scale_backfired":
      return `Escalar ${alvo} já piorou o resultado antes — vale cautela antes de aumentar de novo por aqui.`;
    case "cut_worked":
      return `Cortar/pausar ${alvo} melhorou o resultado antes — foi uma boa jogada nesta conta.`;
    case "account_cut_pays":
      return `Nesta conta, cortar desperdício cedo tende a compensar — foi o que aconteceu em ${r.occurrences} campanhas diferentes.`;
    case "account_scale_backfires":
      return `Nesta conta, escalar sem base sólida tende a piorar o custo — visto em ${r.occurrences} campanhas diferentes.`;
    case "account_scale_pays":
      return `Nesta conta, escalar o que já tem base tende a compensar — foi o que aconteceu em ${r.occurrences} campanhas diferentes.`;
  }
}

// ─── Curadoria: decaimento + contradição ──────────────────────────────────

export interface DecayConfig {
  /** dias sem reforço p/ uma lição ATIVA virar `stale` (some do prompt/UI ativa). */
  readonly staleDays: number;
  /** dias sem reforço p/ uma lição `stale` virar `archived` (some de vez). */
  readonly archiveDays: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Datas de corte do decaimento a partir de `now` — fonte única (repo e testes usam). */
export function decayCutoffs(now: Date, cfg: DecayConfig): { staleBefore: Date; archiveBefore: Date } {
  return {
    staleBefore: new Date(now.getTime() - cfg.staleDays * DAY_MS),
    archiveBefore: new Date(now.getTime() - cfg.archiveDays * DAY_MS),
  };
}

export interface DecayableLesson {
  readonly lifecycle: "active" | "stale" | "archived";
  readonly lastReinforcedAt: Date | null;
}

/**
 * Próximo lifecycle de uma lição pelo tempo sem reforço (contexto muda; lição velha não
 * cala pra sempre). Retorna `null` quando nada muda. Só avança um degrau por vez
 * (`active→stale→archived`) — nunca pula de ativa direto p/ arquivada.
 */
export function applyDecay(lesson: DecayableLesson, now: Date, cfg: DecayConfig): "stale" | "archived" | null {
  if (!lesson.lastReinforcedAt) return null; // sem carimbo de evidência → não decai (seguro)
  const { staleBefore, archiveBefore } = decayCutoffs(now, cfg);
  const at = lesson.lastReinforcedAt.getTime();
  if (lesson.lifecycle === "active" && at < staleBefore.getTime()) return "stale";
  if (lesson.lifecycle === "stale" && at < archiveBefore.getTime()) return "archived";
  return null;
}

/** Abaixo disso, uma contradição além de derrubar a confiança também rebaixa p/ `stale`. */
export const CONTRADICTION_STALE_FLOOR = 0.15;

export interface ContradictionResult {
  readonly confidence: number;
  /** true → a lição deve ser rebaixada a `stale` (confiança caiu demais). */
  readonly demoteToStale: boolean;
}

/** Aplica a queda de confiança de uma contradição (outcome recente contradiz a lição). */
export function applyContradiction(confidence: number | null): ContradictionResult {
  const next = computeConfidence(confidence, { type: "contradict" });
  return { confidence: next, demoteToStale: next < CONTRADICTION_STALE_FLOOR };
}

// ─── Seleção para o brief (teto top-K) ─────────────────────────────────────

/** Lição persistida (projeção que o repo devolve / a seleção consome). */
export interface StoredLesson {
  readonly id: string;
  readonly kind: LessonKind;
  readonly key: SemanticKey;
  readonly content: string;
  readonly confidence: number;
  readonly confirmedByHuman: boolean;
  readonly origin: LessonOrigin;
  readonly lifecycle: "active" | "stale" | "archived";
  readonly reinforceCount: number;
}

/** Lição pronta para o prompt do analista (projeção legível de @trafego/shared + id interno). */
export interface LessonBrief extends BriefLesson {
  readonly id: string;
}

/** Lição-guia consumida pelo guard assimétrico (S3) — só direção/chave, sem texto. */
export interface LessonGuard {
  readonly id: string;
  readonly key: SemanticKey;
}

export interface SelectedLessons {
  readonly prompt: readonly LessonBrief[];
  readonly guards: readonly LessonGuard[];
}

/**
 * Divide as lições ativas em: `prompt` (confirmadas OU confiança ≥ limiar — entram no
 * texto do analista, rotuladas, com teto top-K) e `guards` (hipóteses não-confirmadas —
 * só influência assimétrica/silenciosa). Disciplina do brief: nunca despeja o firehose.
 */
export function selectLessonsForBrief(lessons: readonly StoredLesson[], topK: number): SelectedLessons {
  const active = lessons.filter((l) => l.lifecycle === "active");
  const prompt: StoredLesson[] = [];
  const guards: LessonGuard[] = [];
  for (const l of active) {
    if (l.confirmedByHuman || l.confidence >= PROMPT_CONFIDENCE_THRESHOLD) prompt.push(l);
    else guards.push({ id: l.id, key: l.key });
  }
  prompt.sort((a, b) => {
    if (a.confirmedByHuman !== b.confirmedByHuman) return a.confirmedByHuman ? -1 : 1;
    if (b.confidence !== a.confidence) return b.confidence - a.confidence;
    return b.reinforceCount - a.reinforceCount;
  });
  return {
    prompt: prompt.slice(0, topK).map((l) => ({
      id: l.id,
      content: l.content,
      tier: confidenceTier(l.confidence, l.confirmedByHuman),
      origin: l.origin,
    })),
    guards,
  };
}
