// Aprendizado contínuo — camada PURA (sem IO, testável sem mock). Detecta padrões
// recorrentes no histórico de análise (observacional, vale mesmo sem ação aplicada),
// calcula confiança (nasce baixa; só confirmação humana ou outcome medido de ação
// nossa passam do teto observacional) e prepara a candidata para o redator LLM (que
// SÓ traduz — nunca inventa lição). A curadoria (dedupe/merge/decay/contradição) e a
// medição de outcome de ações nossas entram nas subfatias seguintes reusando estes tipos.

import type { BriefLesson, HealthSignal, LessonConfidenceTier, LessonOrigin, PerformanceTier } from "@trafego/shared";

// ─── Taxonomia (fonte única do tipo) ──────────────────────────────────────

/** Tipo de lição. Mapeia para `memoryType` do DB: `fact`→`fact`, `calibration`→`past_action`. */
export type LessonKind = "fact" | "calibration";

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

export interface LessonEvidence {
  readonly pattern: FactPattern;
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

const HEALTH_SIGNAL_DIMENSION: Partial<Record<HealthSignal, LessonDimension>> = {
  creative_fatigue: "creative",
  weak_creative: "creative",
  weak_hook_retention: "creative",
  audience_saturation: "audience",
};

/**
 * Destila padrões RECORRENTES do histórico de análise → candidatas `fact`. Puro.
 * Só emite quando o padrão persiste (≥ ratio dos runs) e há runs suficientes.
 * Confiança nasce baixa (teto observacional) — vira acionável só com reforço/confirmação.
 */
export function detectFactCandidates(input: DetectFactInput): LessonCandidate[] {
  const cfg = { ...DEFAULT_FACT_DETECTION, ...input.config };
  const runs = input.runs;
  if (runs.length < cfg.minRuns) return [];

  const out: LessonCandidate[] = [];
  const observe = (occurrenceRatio: number): number =>
    computeConfidence(null, { type: "observe", occurrenceRatio, origin: "observational" });

  // ── Padrões por campanha (tier persistente + sinais de saúde recorrentes) ──
  const byCampaign = new Map<string, { name: string; appearances: number; zombie: number; under: number; signals: Map<HealthSignal, number> }>();
  for (const run of runs) {
    for (const c of run.campaigns) {
      const agg = byCampaign.get(c.externalId) ?? { name: c.name, appearances: 0, zombie: 0, under: 0, signals: new Map() };
      agg.name = c.name;
      agg.appearances += 1;
      if (c.tier === "zombie") agg.zombie += 1;
      if (c.tier === "underperformer") agg.under += 1;
      for (const s of c.healthSignals ?? []) agg.signals.set(s, (agg.signals.get(s) ?? 0) + 1);
      byCampaign.set(c.externalId, agg);
    }
  }

  for (const [externalId, agg] of byCampaign) {
    if (agg.appearances < cfg.minRuns) continue;
    const ratioOf = (n: number): number => n / agg.appearances;

    if (ratioOf(agg.zombie) >= cfg.minOccurrenceRatio) {
      const ratio = ratioOf(agg.zombie);
      out.push({
        kind: "fact",
        key: { scope: "entity", dimension: "budget", direction: "lower", subjectId: externalId },
        origin: "observational",
        confidence: observe(ratio),
        evidence: { pattern: "persistent_zombie", occurrences: agg.zombie, totalRuns: agg.appearances, subjectName: agg.name },
      });
    } else if (ratioOf(agg.under) >= cfg.minOccurrenceRatio) {
      const ratio = ratioOf(agg.under);
      out.push({
        kind: "fact",
        key: { scope: "entity", dimension: "pacing", direction: "lower", subjectId: externalId },
        origin: "observational",
        confidence: observe(ratio),
        evidence: { pattern: "persistent_underperformer", occurrences: agg.under, totalRuns: agg.appearances, subjectName: agg.name },
      });
    }

    for (const [signal, count] of agg.signals) {
      const dimension = HEALTH_SIGNAL_DIMENSION[signal];
      if (!dimension || ratioOf(count) < cfg.minOccurrenceRatio) continue;
      out.push({
        kind: "fact",
        key: { scope: "entity", dimension, direction: "lower", subjectId: externalId },
        origin: "observational",
        confidence: observe(ratioOf(count)),
        evidence: { pattern: "recurring_health_signal", occurrences: count, totalRuns: agg.appearances, subjectName: agg.name, healthSignal: signal },
      });
    }
  }

  // ── Tracking suspeito recorrente (nível conta) ──
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

// ─── Redator (LLM só traduz a candidata; fallback determinístico) ──────────

export interface RedactorInput {
  readonly kind: LessonKind;
  readonly dimension: LessonDimension;
  readonly direction: LessonDirection;
  readonly scope: LessonScope;
  readonly pattern: FactPattern;
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
