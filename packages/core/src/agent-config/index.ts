// Semântica PURA da escrita de config do agente (Bloco 2, S2.1). Fonte ÚNICA de
// merge/validação/diff — reusada pela API (hoje) e pelo chat do worker (depois),
// sem drift (§13 reuso-primeiro; §4 functional core). ZERO IO: só dados + decisão.

import type {
  ActionSource,
  ActionType,
  AgentGoals,
  AutonomyLevel,
  AutonomyPolicy,
  CadenceSpec,
  ConversionGoal,
  GuardrailConfig,
} from "@trafego/shared";
import {
  ANALYSIS_WINDOW_DEFAULT_DAYS,
  ANALYSIS_WINDOW_MAX_DAYS,
  ANALYSIS_WINDOW_MIN_DAYS,
} from "@trafego/shared";

/**
 * Estado ATUAL da config do agente (neutro — sem detalhe de banco/plataforma). A
 * casca (pacote de IO) monta isto a partir da linha `agents` + `guardrail_configs`;
 * o resolver só enxerga este shape.
 */
export interface AgentConfigState {
  readonly goals: AgentGoals;
  readonly businessContext: string | null;
  readonly guidance: string | null;
  readonly persona: string | null;
  readonly tone: string | null;
  readonly systemPrompt: string | null;
  readonly cadence: CadenceSpec | null;
  readonly analysisWindowDays: number;
  readonly autonomyPolicy: AutonomyPolicy;
  readonly guardrails: GuardrailConfig;
  readonly modelConfig: Record<string, unknown>;
}

// Nota: os leaves aceitam `| undefined` de propósito — os patches vêm de DTOs
// inferidos por zod (que carregam `| undefined` sob exactOptionalPropertyTypes). Os
// valores são normalizados a jusante (cleanGoals / merge), então o `next` fica estrito.

/** Meta do agente em formato de patch (leaves toleram `undefined` do DTO). */
export interface AgentGoalsPatch {
  readonly targetCPA?: number | undefined;
  readonly targetROAS?: number | undefined;
  readonly conversionGoal?: ConversionGoal | undefined;
  readonly customConversionId?: string | undefined;
}

/** Guardrails em formato de patch (leaf `llmCostCapUsd` tolera `undefined` do DTO). */
export interface GuardrailConfigPatch {
  readonly maxBudgetChangePct: number;
  readonly maxEntitiesPerDay: number;
  readonly allowedActions: readonly ActionType[];
  readonly dryRun: boolean;
  readonly killSwitch: boolean;
  readonly llmCostCapUsd?: number | undefined;
}

/** Knobs de "Opções avançadas" (6c) — patch parcial do model_config (fora `quality`). */
export interface ModelConfigPatch {
  readonly model?: string | undefined;
  readonly unitModel?: string | undefined;
  readonly messageModel?: string | undefined;
  readonly visionModel?: string | undefined;
  readonly reviewEnabled?: boolean | undefined;
  readonly topN?: number | undefined;
  readonly maxOutputTokens?: number | undefined;
  /** limiares de qualidade (merge campo-a-campo). */
  readonly quality?: Record<string, unknown> | undefined;
}

/**
 * Patch de config (equivalente parcial ao `AgentConfigInput` da API). Semântica dos
 * campos de texto: `""` limpa (→ null via `trimOrNull`); `undefined` preserva;
 * `systemPrompt ""` → null (cai no arquétipo). `cadence: null` limpa a cadência.
 */
export interface AgentConfigPatch {
  readonly goals?: AgentGoalsPatch | undefined;
  readonly businessContext?: string | undefined;
  readonly guidance?: string | undefined;
  readonly persona?: string | undefined;
  readonly tone?: string | undefined;
  readonly systemPrompt?: string | undefined;
  readonly cadence?: CadenceSpec | null | undefined;
  readonly analysisWindowDays?: number | undefined;
  readonly autonomyPolicy?: AutonomyPolicy | undefined;
  readonly guardrails?: GuardrailConfigPatch | undefined;
  readonly modelConfig?: ModelConfigPatch | undefined;
}

/**
 * Rótulos PT curtos e ESTÁVEIS por campo (p/ o eco "o que mudou" do chat). Estáveis
 * = não vazam fase/impl (§13); crescer o schema = 1 entrada aqui.
 */
export const CONFIG_CHANGE_LABELS = {
  goals: "meta",
  autonomyPolicy: "autonomia",
  guardrails: "guardrails",
  cadence: "cadência",
  businessContext: "contexto",
  guidance: "orientações",
  persona: "persona",
  tone: "tom",
  systemPrompt: "prompt",
  analysisWindowDays: "janela",
  modelConfig: "limiares",
} as const;

/** Ranking de autonomia (menor = mais seguro) — base do "enfraqueceu a segurança?". */
export const AUTONOMY_RANK: Readonly<Record<AutonomyLevel, number>> = {
  notify: 0,
  suggest: 1,
  act_safe: 2,
  act_full: 3,
};

/** Mensagem PT do único erro de validação da config (conversão personalizada sem id). */
export const CUSTOM_CONVERSION_REQUIRED_ERROR =
  "Escolha qual conversão personalizada usar como resultado do negócio.";

/** Resultado do resolver — decisão tipada (§13: sem exceção no core). */
export interface AgentConfigResolution {
  /** próximo estado (mesclado). Em caso de `error`, é o `state` inalterado. */
  readonly next: AgentConfigState;
  /** rótulos dos campos que mudaram (p/ o eco do chat). */
  readonly changed: readonly string[];
  /** algum campo relevante à ANÁLISE mudou → força 1 deep run (cadência NÃO conta). */
  readonly runRelevantChanged: boolean;
  /** a cadência mudou → re-sincronizar o schedule. */
  readonly cadenceChanged: boolean;
  /** a mudança ENFRAQUECE a segurança (guardrail afrouxado / autonomia subiu). */
  readonly weakensSafety: boolean;
  /** validação falhou (PT) — não persistir. */
  readonly error?: string;
}

/**
 * Centraliza a SEMÂNTICA de merge/validação/diff da config. Puro e testável sem
 * mock. A casca só aplica o `next` (persistência) conforme os flags.
 */
export function resolveAgentConfigChange(
  state: AgentConfigState,
  patch: AgentConfigPatch,
): AgentConfigResolution {
  const nextGoals = cleanGoals(patch.goals ?? state.goals);
  // conversão personalizada exige o id (senão o brief casaria uma custom arbitrária).
  if (nextGoals.conversionGoal === "custom" && !nextGoals.customConversionId) {
    return {
      next: state,
      changed: [],
      runRelevantChanged: false,
      cadenceChanged: false,
      weakensSafety: false,
      error: CUSTOM_CONVERSION_REQUIRED_ERROR,
    };
  }

  // texto: "" limpa (trimOrNull); undefined preserva. cadence null limpa; undefined preserva.
  const nextBusinessContext =
    patch.businessContext !== undefined ? trimOrNull(patch.businessContext) : state.businessContext;
  const nextGuidance = patch.guidance !== undefined ? trimOrNull(patch.guidance) : state.guidance;
  const nextPersona = patch.persona !== undefined ? trimOrNull(patch.persona) : state.persona;
  const nextTone = patch.tone !== undefined ? trimOrNull(patch.tone) : state.tone;
  const nextSystemPrompt =
    patch.systemPrompt !== undefined ? trimOrNull(patch.systemPrompt) : state.systemPrompt;
  const nextCadence = patch.cadence !== undefined ? patch.cadence : state.cadence;
  const nextWindow = patch.analysisWindowDays ?? state.analysisWindowDays;
  const nextModelConfig = mergeAdvancedConfig(state.modelConfig, nextWindow, patch.modelConfig);
  const nextAutonomy = patch.autonomyPolicy ?? state.autonomyPolicy;
  const nextGuardrails = cleanGuardrails(patch.guardrails ?? state.guardrails);

  const next: AgentConfigState = {
    goals: nextGoals,
    businessContext: nextBusinessContext,
    guidance: nextGuidance,
    persona: nextPersona,
    tone: nextTone,
    systemPrompt: nextSystemPrompt,
    cadence: nextCadence,
    analysisWindowDays: nextWindow,
    autonomyPolicy: nextAutonomy,
    guardrails: nextGuardrails,
    modelConfig: nextModelConfig,
  };

  // diffs por campo (json estável p/ objetos).
  const goalsChanged = jsonEq(nextGoals, cleanGoals(state.goals)) === false;
  const businessContextChanged = nextBusinessContext !== state.businessContext;
  const guidanceChanged = nextGuidance !== state.guidance;
  const personaChanged = nextPersona !== state.persona;
  const toneChanged = nextTone !== state.tone;
  const systemPromptChanged = nextSystemPrompt !== state.systemPrompt;
  const windowChanged = nextWindow !== state.analysisWindowDays;
  // knobs de qualidade/modelo: qualquer submissão força o deep (herança incremental
  // não olha config) — mesma regra do updateConfig original.
  const modelConfigTouched = patch.modelConfig !== undefined;
  const cadenceChanged = jsonEq(nextCadence, state.cadence) === false;
  const autonomyChanged = jsonEq(nextAutonomy, state.autonomyPolicy) === false;
  const guardrailsChanged = jsonEq(nextGuardrails, state.guardrails) === false;

  // cadência NÃO entra: muda só a agenda, não a análise.
  const runRelevantChanged =
    goalsChanged ||
    businessContextChanged ||
    guidanceChanged ||
    personaChanged ||
    toneChanged ||
    systemPromptChanged ||
    windowChanged ||
    modelConfigTouched;

  const changed: string[] = [];
  if (goalsChanged) changed.push(CONFIG_CHANGE_LABELS.goals);
  if (autonomyChanged) changed.push(CONFIG_CHANGE_LABELS.autonomyPolicy);
  if (guardrailsChanged) changed.push(CONFIG_CHANGE_LABELS.guardrails);
  if (cadenceChanged) changed.push(CONFIG_CHANGE_LABELS.cadence);
  if (businessContextChanged) changed.push(CONFIG_CHANGE_LABELS.businessContext);
  if (guidanceChanged) changed.push(CONFIG_CHANGE_LABELS.guidance);
  if (personaChanged) changed.push(CONFIG_CHANGE_LABELS.persona);
  if (toneChanged) changed.push(CONFIG_CHANGE_LABELS.tone);
  if (systemPromptChanged) changed.push(CONFIG_CHANGE_LABELS.systemPrompt);
  if (windowChanged) changed.push(CONFIG_CHANGE_LABELS.analysisWindowDays);
  if (modelConfigTouched) changed.push(CONFIG_CHANGE_LABELS.modelConfig);

  const weakensSafety =
    guardrailsWeaken(state.guardrails, nextGuardrails) ||
    autonomyPolicyWeakens(state.autonomyPolicy, nextAutonomy);

  return { next, changed, runRelevantChanged, cadenceChanged, weakensSafety };
}

/**
 * A mudança de guardrail ENFRAQUECE a rede? (blast radius maior, ação nova liberada,
 * dry-run/kill-switch desligados). PURO.
 */
export function guardrailsWeaken(prev: GuardrailConfig, next: GuardrailConfig): boolean {
  if (!prev || !next) return false;
  if (next.maxBudgetChangePct > prev.maxBudgetChangePct) return true;
  if (next.maxEntitiesPerDay > prev.maxEntitiesPerDay) return true;
  const prevAllowed = new Set(prev.allowedActions);
  if (next.allowedActions.some((a) => !prevAllowed.has(a))) return true;
  if (prev.dryRun && !next.dryRun) return true;
  if (prev.killSwitch && !next.killSwitch) return true;
  return false;
}

/** Alguma origem subiu no ranking de autonomia (ficou mais autônoma)? PURO. */
export function autonomyPolicyWeakens(prev: AutonomyPolicy, next: AutonomyPolicy): boolean {
  const p = prev?.bySource;
  const n = next?.bySource;
  if (!p || !n) return false;
  return (Object.keys(n) as ActionSource[]).some((src) => AUTONOMY_RANK[n[src]] > AUTONOMY_RANK[p[src]]);
}

// ─── Helpers puros (migrados do service da API — fonte única) ────────────────

/** Só as chaves definidas (exactOptionalPropertyTypes — sem gravar `undefined`). */
export function cleanGoals(g: AgentGoalsPatch | undefined): AgentGoals {
  const src = g ?? {};
  return {
    ...(src.targetCPA !== undefined ? { targetCPA: src.targetCPA } : {}),
    ...(src.targetROAS !== undefined ? { targetROAS: src.targetROAS } : {}),
    ...(src.conversionGoal !== undefined ? { conversionGoal: src.conversionGoal } : {}),
    ...(src.customConversionId !== undefined ? { customConversionId: src.customConversionId } : {}),
  };
}

/** Normaliza os guardrails p/ o shape estrito (omite `llmCostCapUsd` ausente). */
export function cleanGuardrails(g: GuardrailConfigPatch): GuardrailConfig {
  return {
    maxBudgetChangePct: g.maxBudgetChangePct,
    maxEntitiesPerDay: g.maxEntitiesPerDay,
    allowedActions: g.allowedActions,
    dryRun: g.dryRun,
    killSwitch: g.killSwitch,
    ...(g.llmCostCapUsd !== undefined ? { llmCostCapUsd: g.llmCostCapUsd } : {}),
  };
}

/** Texto aparado, ou null quando vazio (mantém o DB limpo; "" limpa o campo). */
export function trimOrNull(s: string): string | null {
  const t = s.trim();
  return t.length > 0 ? t : null;
}

/** Knobs escalares de "Opções avançadas" (6c) reconhecidos no model_config (fora quality). */
export const ADVANCED_SCALAR_KEYS = [
  "model",
  "unitModel",
  "messageModel",
  "visionModel",
  "reviewEnabled",
  "topN",
  "maxOutputTokens",
] as const;

/** Merge dos knobs avançados no model_config, preservando outras chaves (windowDays). */
export function mergeAdvancedConfig(
  current: Readonly<Record<string, unknown>>,
  windowDays: number,
  patch: ModelConfigPatch | undefined,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...current, windowDays };
  if (!patch) return out;
  for (const k of ADVANCED_SCALAR_KEYS) if (patch[k] !== undefined) out[k] = patch[k];
  if (patch.quality) {
    const curQ = out.quality && typeof out.quality === "object" ? (out.quality as Record<string, unknown>) : {};
    const nextQ: Record<string, unknown> = { ...curQ };
    for (const [qk, qv] of Object.entries(patch.quality)) if (qv !== undefined) nextQ[qk] = qv;
    out.quality = nextQ;
  }
  return out;
}

/** Janela salva no model_config (ou o default), capada aos limites. PURO. */
export function windowFromModelConfig(mc: Readonly<Record<string, unknown>> | null | undefined): number {
  const raw = mc?.windowDays;
  if (typeof raw !== "number" || !Number.isFinite(raw)) return ANALYSIS_WINDOW_DEFAULT_DAYS;
  return Math.min(ANALYSIS_WINDOW_MAX_DAYS, Math.max(ANALYSIS_WINDOW_MIN_DAYS, Math.floor(raw)));
}

/** Igualdade estrutural por JSON (objetos de config pequenos e serializáveis). */
function jsonEq(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
