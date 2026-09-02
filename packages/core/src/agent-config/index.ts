// Semântica PURA da escrita de config do agente (Bloco 2, S2.1). Fonte ÚNICA de
// merge/validação/diff — reusada pela API (hoje) e pelo chat do worker (depois),
// sem drift (§13 reuso-primeiro; §4 functional core). ZERO IO: só dados + decisão.

import type {
  ActionSource,
  ActionType,
  AgentGoals,
  AlertSensitivity,
  AutonomyLevel,
  AutonomyPolicy,
  CadenceSpec,
  ConversionGoal,
  DidacticDepth,
  Directiveness,
  ExperienceLevel,
  GuardrailConfig,
  MetaAccountHealthStatus,
  NotifyPolicy,
  Posture,
  Volume,
} from "@trafego/shared";
import {
  ACCOUNT_HEALTH_STATUS_LABELS,
  AGENT_IDENTITY_FIELD_MAX,
  AGENT_PROMPT_FIELD_MAX,
  AGENT_TEXT_FIELD_MAX,
  ALERTABLE_ACCOUNT_HEALTH_STATUSES,
  ANALYSIS_WINDOW_DEFAULT_DAYS,
  ANALYSIS_WINDOW_MAX_DAYS,
  ANALYSIS_WINDOW_MIN_DAYS,
  DEFAULT_CURRENCY,
  formatMoney,
} from "@trafego/shared";
import { describeCadence } from "../cadence/index.js";
import {
  experienceLabel,
  experiencePresetDefaults,
  POSTURE_AXIS_PT,
  postureLevelLabel,
} from "../posture/index.js";

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
  /** Política de notificação proativa (F4d) — pulso/alerta/push. */
  readonly notifyPolicy: NotifyPolicy;
  /** Postura de comunicação (voz) — diretividade/volume/profundidade + preset. */
  readonly posture: Posture;
  /** On/off por-ação (A3, `agent_tool_bindings` já resolvido) — as 6 capacidades gateáveis
   *  (pause_entity/resume_entity/set_status/adjust_budget/create_campaign/duplicate_scale). A
   *  casca resolve via `resolveEnabledTools` (fallback allowedActions/default) antes de montar
   *  o estado — o resolver aqui só enxerga o booleano final. */
  readonly toolBindings: Readonly<Record<string, boolean>>;
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
  // limites de gasto novo (Fatia 7).
  readonly maxNewDailyBudgetMinor?: number | undefined;
  readonly maxNewCampaignsPerDay?: number | undefined;
  readonly scalePct?: number | undefined;
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
  /** estratégia de fonte do criativo na criação (Slice 10) — objeto pequeno, trocado como unidade. */
  readonly creativeSource?: { readonly mode: string; readonly servingPick?: string | undefined } | undefined;
}

/**
 * Notificação proativa (F4d) em formato de patch — leaves FLAT (mesmo padrão de
 * `GuardrailConfigPatch`): só sobrepõe os campos enviados, resto preserva o atual.
 */
export interface NotifyPolicyPatch {
  readonly pulseEnabled?: boolean | undefined;
  readonly pulseCadence?: CadenceSpec | undefined;
  readonly alertsEnabled?: boolean | undefined;
  readonly alertsSensitivity?: AlertSensitivity | undefined;
  readonly alertsThrottleHours?: number | undefined;
  readonly runPushEnabled?: boolean | undefined;
  readonly reactivationEnabled?: boolean | undefined;
  readonly proactiveDraftsEnabled?: boolean | undefined;
  /** liga/desliga o alerta de saúde da conta Meta (desativada/teto/pagamento) — via chat. */
  readonly accountHealthEnabled?: boolean | undefined;
  /** checklist de status que dispara aviso — lista COMPLETA que substitui a atual (via chat).
   *  Subconjunto alertável (exclui "active"), igual ao schema. */
  readonly accountHealthStatusTriggers?: NonNullable<NotifyPolicy["accountHealthAlert"]>["statusTriggers"] | undefined;
  /** fonte do teto: "meta_cap" (usa o da Meta) ou "custom" — via chat (permite voltar pra meta_cap). */
  readonly accountHealthSpendSource?: "meta_cap" | "custom" | undefined;
  /** teto de gasto CUSTOMIZADO (moeda da conta) — definir também troca a fonte pra "custom" — via chat. */
  readonly accountHealthSpendThresholdMajor?: number | undefined;
  /** liga/desliga o aviso de SALDO baixo (dinheiro acabando) — via chat. */
  readonly accountHealthBalanceEnabled?: boolean | undefined;
  /** limiar de SALDO baixo CUSTOMIZADO (moeda da conta) — via chat. */
  readonly accountHealthBalanceThresholdMajor?: number | undefined;
  /** objeto COMPLETO (site) — o site edita tudo de uma vez; usado como base do merge.
   *  Os campos flat acima (chat) sobrepõem por cima quando presentes. */
  readonly accountHealthAlert?: NotifyPolicy["accountHealthAlert"] | undefined;
}

/**
 * Postura (voz) em formato de patch — leaves FLAT. `experienceLevel` semeia os 3
 * eixos (preset); um eixo explícito no mesmo patch sobrepõe a semente.
 */
export interface PosturePatch {
  readonly directiveness?: Directiveness | undefined;
  readonly volume?: Volume | undefined;
  readonly didacticDepth?: DidacticDepth | undefined;
  readonly experienceLevel?: ExperienceLevel | undefined;
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
  /** proatividade (F4d): pulso/alerta/push. Leaf-merge — só os campos enviados. */
  readonly notifyPolicy?: NotifyPolicyPatch | undefined;
  /** postura (voz): diretividade/volume/profundidade + preset. Leaf-merge. */
  readonly posture?: PosturePatch | undefined;
  /** on/off por-ação (A3) — só as chaves ENVIADAS mudam (leaf-merge); ausentes preservam o
   *  estado atual. Persistido à parte (agent_tool_bindings, não é coluna de `agents`). */
  readonly toolBindings?: Partial<Record<string, boolean>> | undefined;
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
  notifyPolicy: "notificações",
  posture: "postura",
  toolBindings: "ações permitidas",
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

/** Nenhuma coluna mudou (casos de erro/no-op — o estado volta inalterado). */
const NO_COLUMNS_CHANGED: AgentColumnsChanged = {
  goals: false, businessContext: false, guidance: false, persona: false, tone: false,
  systemPrompt: false, cadence: false, modelConfig: false, autonomyPolicy: false,
  notifyPolicy: false, posture: false,
};

/** Quais COLUNAS de `agents` mudaram — a casca faz UPDATE só das true (cirúrgico, F-worker-1). */
export interface AgentColumnsChanged {
  readonly goals: boolean;
  readonly businessContext: boolean;
  readonly guidance: boolean;
  readonly persona: boolean;
  readonly tone: boolean;
  readonly systemPrompt: boolean;
  readonly cadence: boolean;
  readonly modelConfig: boolean;
  readonly autonomyPolicy: boolean;
  readonly notifyPolicy: boolean;
  readonly posture: boolean;
}

/** Resultado do resolver — decisão tipada (§13: sem exceção no core). */
export interface AgentConfigResolution {
  /** próximo estado (mesclado). Em caso de `error`, é o `state` inalterado. */
  readonly next: AgentConfigState;
  /** rótulos dos campos que mudaram (p/ o eco do chat). */
  readonly changed: readonly string[];
  /** colunas de `agents` que mudaram (a casca escreve só essas — UPDATE cirúrgico). */
  readonly columnsChanged: AgentColumnsChanged;
  /** algum campo relevante à ANÁLISE mudou → força 1 deep run (cadência NÃO conta). */
  readonly runRelevantChanged: boolean;
  /** a cadência mudou → re-sincronizar o schedule. */
  readonly cadenceChanged: boolean;
  /** a proatividade (F4d) mudou → o pulso tem scheduler próprio, também re-sincroniza. */
  readonly notifyPolicyChanged: boolean;
  /** o on/off por-ação (A3) mudou → a casca persiste em `agent_tool_bindings` (tabela à
   *  parte, não é coluna de `agents`/`guardrail_configs`). */
  readonly toolBindingsChanged: boolean;
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
      columnsChanged: NO_COLUMNS_CHANGED,
      runRelevantChanged: false,
      cadenceChanged: false,
      notifyPolicyChanged: false,
      toolBindingsChanged: false,
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

  // Teto de texto (mesmo do site/API): o chat pode mandar textão. NÃO trunca em
  // silêncio (perderia sentido) — devolve erro guiando o agente a OFERECER condensar
  // mantendo o essencial (regra no system prompt). Só valida o que o patch tocou.
  const tooLong =
    (patch.businessContext !== undefined && overCap(nextBusinessContext, AGENT_TEXT_FIELD_MAX, CONFIG_CHANGE_LABELS.businessContext)) ||
    (patch.guidance !== undefined && overCap(nextGuidance, AGENT_TEXT_FIELD_MAX, CONFIG_CHANGE_LABELS.guidance)) ||
    (patch.persona !== undefined && overCap(nextPersona, AGENT_IDENTITY_FIELD_MAX, CONFIG_CHANGE_LABELS.persona)) ||
    (patch.tone !== undefined && overCap(nextTone, AGENT_IDENTITY_FIELD_MAX, CONFIG_CHANGE_LABELS.tone)) ||
    (patch.systemPrompt !== undefined && overCap(nextSystemPrompt, AGENT_PROMPT_FIELD_MAX, CONFIG_CHANGE_LABELS.systemPrompt));
  if (tooLong) {
    return {
      next: state,
      changed: [],
      columnsChanged: NO_COLUMNS_CHANGED,
      runRelevantChanged: false,
      cadenceChanged: false,
      notifyPolicyChanged: false,
      toolBindingsChanged: false,
      weakensSafety: false,
      error: tooLong,
    };
  }
  const nextCadence = patch.cadence !== undefined ? patch.cadence : state.cadence;
  const nextWindow = patch.analysisWindowDays ?? state.analysisWindowDays;
  const nextModelConfig = mergeAdvancedConfig(state.modelConfig, nextWindow, patch.modelConfig);
  const nextAutonomy = patch.autonomyPolicy ?? state.autonomyPolicy;
  const nextGuardrails = cleanGuardrails(patch.guardrails ?? state.guardrails);
  const nextNotifyPolicy = mergeNotifyPolicy(state.notifyPolicy, patch.notifyPolicy);
  const nextPosture = mergePosture(state.posture, patch.posture);
  const toolBindingsEntries = patch.toolBindings
    ? Object.entries(patch.toolBindings).filter((e): e is [string, boolean] => typeof e[1] === "boolean")
    : [];
  const nextToolBindings: Readonly<Record<string, boolean>> =
    toolBindingsEntries.length > 0 ? { ...state.toolBindings, ...Object.fromEntries(toolBindingsEntries) } : state.toolBindings;

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
    notifyPolicy: nextNotifyPolicy,
    posture: nextPosture,
    toolBindings: nextToolBindings,
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
  // proatividade (F4d): não afeta a ANÁLISE (não entra em runRelevantChanged), mas o
  // pulso tem cadência própria → precisa re-sincronizar o scheduler (como a cadência).
  const notifyPolicyChanged = jsonEq(nextNotifyPolicy, state.notifyPolicy) === false;
  // postura é VOZ (render) — não afeta a ANÁLISE (fora de runRelevantChanged); o
  // próximo run relê a config no redator, como cadência/notify.
  const postureChanged = jsonEq(nextPosture, state.posture) === false;
  const toolBindingsChanged = jsonEq(nextToolBindings, state.toolBindings) === false;

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
  if (notifyPolicyChanged) changed.push(CONFIG_CHANGE_LABELS.notifyPolicy);
  if (postureChanged) changed.push(CONFIG_CHANGE_LABELS.posture);
  if (toolBindingsChanged) changed.push(CONFIG_CHANGE_LABELS.toolBindings);

  const weakensSafety =
    guardrailsWeaken(state.guardrails, nextGuardrails) ||
    autonomyPolicyWeakens(state.autonomyPolicy, nextAutonomy);

  // colunas de `agents` que REALMENTE mudaram — a casca escreve só essas (UPDATE cirúrgico),
  // em vez de reescrever a linha inteira (que tocava autonomy_policy/goals mesmo num patch só de
  // quality e abria janela de lost-update com edições concorrentes). (F-worker-1)
  const columnsChanged: AgentColumnsChanged = {
    goals: goalsChanged,
    businessContext: businessContextChanged,
    guidance: guidanceChanged,
    persona: personaChanged,
    tone: toneChanged,
    systemPrompt: systemPromptChanged,
    cadence: cadenceChanged,
    // a janela de análise mora DENTRO do model_config (windowDays) → mudou a janela = mudou a coluna.
    modelConfig: modelConfigTouched || windowChanged,
    autonomyPolicy: autonomyChanged,
    notifyPolicy: notifyPolicyChanged,
    posture: postureChanged,
  };

  return { next, changed, columnsChanged, runRelevantChanged, cadenceChanged, notifyPolicyChanged, toolBindingsChanged, weakensSafety };
}

/** Mescla o patch de notificação (leaf-a-leaf) no estado atual. Sempre retorna o shape cheio. */
function mergeNotifyPolicy(cur: NotifyPolicy, patch: NotifyPolicyPatch | undefined): NotifyPolicy {
  if (!patch) return cur;
  return {
    pulse: {
      enabled: patch.pulseEnabled ?? cur.pulse.enabled,
      cadence: patch.pulseCadence ?? cur.pulse.cadence,
    },
    alerts: {
      enabled: patch.alertsEnabled ?? cur.alerts.enabled,
      sensitivity: patch.alertsSensitivity ?? cur.alerts.sensitivity,
      throttleHours: patch.alertsThrottleHours ?? cur.alerts.throttleHours,
    },
    runPush: { enabled: patch.runPushEnabled ?? cur.runPush.enabled },
    // defensivo: linhas pré-pivô podem não ter `reactivation` no jsonb → default off.
    reactivation: { enabled: patch.reactivationEnabled ?? cur.reactivation?.enabled ?? false },
    proactiveDrafts: { enabled: patch.proactiveDraftsEnabled ?? cur.proactiveDrafts?.enabled ?? false },
    accountHealthAlert: mergeAccountHealthAlert(cur.accountHealthAlert, patch),
  };
}

/** Descreve o teto de gasto do alerta de saúde (chat/eco): valor customizado (na moeda da
 *  CONTA — o threshold é sempre nela) ou "teto da Meta". */
function describeSpendThreshold(alert: NotifyPolicy["accountHealthAlert"], currency: string): string {
  const t = alert?.spendThreshold;
  return t?.source === "custom" && t.customValueMajor !== undefined
    ? formatMoney(t.customValueMajor, currency)
    : "teto da Meta";
}

/** Descreve o aviso de saldo baixo (chat/eco): valor na moeda da conta, "ligado" (sem valor) ou "desligado". */
function describeBalanceThreshold(alert: NotifyPolicy["accountHealthAlert"], currency: string): string {
  const b = alert?.balanceThreshold;
  if (!b?.enabled) return "desligado";
  return b.customValueMajor !== undefined ? formatMoney(b.customValueMajor, currency) : "ligado";
}

/** Eco da mudança no checklist de status: descreve os estados que passaram/deixaram de avisar. */
function describeStatusTriggerChange(
  cur: NotifyPolicy["accountHealthAlert"],
  next: NotifyPolicy["accountHealthAlert"],
): string | null {
  const c = new Set(cur?.statusTriggers ?? ALERTABLE_ACCOUNT_HEALTH_STATUSES);
  const n = new Set(next?.statusTriggers ?? ALERTABLE_ACCOUNT_HEALTH_STATUSES);
  const label = (s: MetaAccountHealthStatus) => ACCOUNT_HEALTH_STATUS_LABELS[s as Exclude<MetaAccountHealthStatus, "active">];
  const added = [...n].filter((s) => !c.has(s)).map(label);
  const removed = [...c].filter((s) => !n.has(s)).map(label);
  if (added.length === 0 && removed.length === 0) return null;
  const parts: string[] = [];
  if (added.length > 0) parts.push(`passa a avisar em: ${added.join(", ")}`);
  if (removed.length > 0) parts.push(`deixa de avisar em: ${removed.join(", ")}`);
  return `estados que disparam aviso — ${parts.join("; ")}`;
}

/** Merge do alerta de saúde de conta. O chat mexe em TODOS os campos (paridade com o site):
 *  enabled, checklist de status, fonte+valor do teto e saldo (on/off + valor). Linha
 *  pré-fatia sem o objeto → default seguro (ON + todos os status marcados). */
function mergeAccountHealthAlert(
  cur: NotifyPolicy["accountHealthAlert"],
  patch: NotifyPolicyPatch,
): NotifyPolicy["accountHealthAlert"] {
  // base = objeto COMPLETO do site (patch.accountHealthAlert) › estado atual › default seguro.
  const base = patch.accountHealthAlert ??
    cur ?? {
      enabled: true,
      statusTriggers: [...ALERTABLE_ACCOUNT_HEALTH_STATUSES],
      spendThreshold: { source: "meta_cap" as const },
      balanceThreshold: { enabled: false },
    };
  // campos FLAT do chat sobrepõem por cima (leaf-merge só do que o chat mandou).
  const statusTriggers =
    patch.accountHealthStatusTriggers !== undefined ? [...patch.accountHealthStatusTriggers] : base.statusTriggers;
  // teto: "meta_cap" explícito volta pra Meta (sem valor); senão valor definido → custom; senão preserva.
  const spendThreshold =
    patch.accountHealthSpendSource === "meta_cap"
      ? { source: "meta_cap" as const }
      : patch.accountHealthSpendThresholdMajor !== undefined
        ? { source: "custom" as const, customValueMajor: patch.accountHealthSpendThresholdMajor }
        : base.spendThreshold;
  // saldo: on/off e valor leaf-merge (exactOptional → só inclui customValueMajor quando existe).
  const balanceEnabled = patch.accountHealthBalanceEnabled ?? base.balanceThreshold.enabled;
  const balanceValue = patch.accountHealthBalanceThresholdMajor ?? base.balanceThreshold.customValueMajor;
  const balanceThreshold = {
    enabled: balanceEnabled,
    ...(balanceValue !== undefined ? { customValueMajor: balanceValue } : {}),
  };
  return {
    ...base,
    enabled: patch.accountHealthEnabled ?? base.enabled,
    statusTriggers,
    spendThreshold,
    balanceThreshold,
  };
}

/**
 * Mescla o patch de postura (voz). Se `experienceLevel` vier, SEMEIA os 3 eixos com o
 * preset; um eixo explícito no mesmo patch sobrepõe a semente. Sem preset, leaf-merge
 * simples (mexer num eixo mantém o `experienceLevel` — "personalizado" é derivado). PURO.
 */
function mergePosture(cur: Posture, patch: PosturePatch | undefined): Posture {
  if (!patch) return cur;
  const seed = patch.experienceLevel !== undefined ? experiencePresetDefaults(patch.experienceLevel) : cur;
  return {
    directiveness: patch.directiveness ?? seed.directiveness,
    volume: patch.volume ?? seed.volume,
    didacticDepth: patch.didacticDepth ?? seed.didacticDepth,
    experienceLevel: patch.experienceLevel ?? cur.experienceLevel,
  };
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
    ...(g.maxNewDailyBudgetMinor !== undefined ? { maxNewDailyBudgetMinor: g.maxNewDailyBudgetMinor } : {}),
    ...(g.maxNewCampaignsPerDay !== undefined ? { maxNewCampaignsPerDay: g.maxNewCampaignsPerDay } : {}),
    ...(g.scalePct !== undefined ? { scalePct: g.scalePct } : {}),
  };
}

/** Texto aparado, ou null quando vazio (mantém o DB limpo; "" limpa o campo). */
export function trimOrNull(s: string): string | null {
  const t = s.trim();
  return t.length > 0 ? t : null;
}

/**
 * Se o texto passou do teto, devolve a mensagem de erro (que guia o agente a
 * OFERECER condensar mantendo o essencial); senão `null`. Não trunca — quem decide
 * o corte é o agente/usuário, não o sistema.
 */
export function overCap(value: string | null, max: number, label: string): string | null {
  if (value === null || value.length <= max) return null;
  return `O texto de ${label} ficou com ${value.length} caracteres, mas o limite é ${max}. Não dá pra salvar assim — me diga que quer que eu resuma mantendo o essencial e eu proponho uma versão mais curta.`;
}

/** Modo de escrita de um campo de texto acumulativo (orientações/contexto). */
export type ConfigTextMode = "append" | "replace";

/**
 * Merge determinístico de um campo de texto acumulativo (orientações/contexto):
 * `append` PRESERVA o valor atual e acrescenta o novo numa nova linha (nunca perde
 * texto); `replace` substitui. Vazio (só espaços) → replace (limpa). Puro.
 */
export function mergeConfigText(current: string | null, text: string, mode: ConfigTextMode): string {
  const add = text.trim();
  const cur = (current ?? "").trim();
  if (mode === "append" && cur.length > 0 && add.length > 0) return `${cur}\n${add}`;
  return text;
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
  // estratégia de criativo = objeto pequeno (mode + servingPick), trocado como unidade (trocar
  // pra `library` não deve preservar um `servingPick` obsoleto).
  if (patch.creativeSource !== undefined) out.creativeSource = patch.creativeSource;
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

// ─── Eco determinístico de mudança de config (chat, S2.3) ────────────────────
// PURO: a "verdade fixa" que o chat ecoa antes de aplicar QUALQUER mudança de config
// (CLAUDE §8: eco+confirma). 1 mudança por linha, "campo: <antes> → <depois>". O LLM
// não pode alterar os valores — o gate congela este texto + o patch. Sem IO.

/** Nível de autonomia em PT (rótulo de gente, não o enum). */
const AUTONOMY_LABEL_PT: Readonly<Record<AutonomyLevel, string>> = {
  notify: "só avisa",
  suggest: "sugere e pede OK",
  act_safe: "age no seguro",
  act_full: "age sozinho",
};

/** Origem da ação em PT (autonomia é por origem). */
const SOURCE_LABEL_PT: Readonly<Record<ActionSource, string>> = {
  playbook: "playbook (regras)",
  llm: "análise por IA",
};

/** Tipo de ação em PT (ações permitidas do guardrail). */
const ACTION_TYPE_LABEL_PT: Readonly<Record<ActionType, string>> = {
  pause_entity: "pausar",
  resume_entity: "reativar",
  adjust_budget: "ajustar budget",
  set_status: "mudar status",
};

/** Conversão de negócio em PT (fallback = a chave neutra). */
const CONVERSION_GOAL_LABEL_PT: Partial<Record<ConversionGoal, string>> = {
  purchase: "compra",
  lead: "lead",
  registration: "cadastro",
  initiate_checkout: "início de checkout",
  add_to_cart: "adição ao carrinho",
  view_content: "visualização de conteúdo",
  add_payment_info: "adição de pagamento",
  search: "busca",
  contact: "contato",
  subscribe: "inscrição",
  start_trial: "início de teste",
  submit_application: "envio de inscrição",
  messaging_started: "conversa iniciada",
  app_install: "instalação de app",
  custom: "conversão personalizada",
};

/** Sensibilidade do alerta em PT (rótulo de gente). */
const ALERT_SENSITIVITY_LABEL_PT: Readonly<Record<AlertSensitivity, string>> = {
  low: "baixa",
  normal: "normal",
  high: "alta",
};

const onOff = (b: boolean): string => (b ? "ligado" : "desligado");
const moneyOrNone = (reais: number | undefined, currency: string): string =>
  reais == null ? "não definido" : formatMoney(reais, currency);
const roasOrNone = (r: number | undefined): string => (r == null ? "não definido" : `${r}x`);
const conversionLabel = (g: ConversionGoal | undefined): string =>
  g ? (CONVERSION_GOAL_LABEL_PT[g] ?? g) : "não definida";
const actionsLabel = (actions: readonly ActionType[]): string =>
  actions.length > 0 ? actions.map((a) => ACTION_TYPE_LABEL_PT[a] ?? a).join(", ") : "nenhuma";

/** Teto do preview de campo de texto no eco (WhatsApp — legível, não a parede toda). */
const ECHO_PREVIEW_MAX = 140;
/** Preview do NOVO valor de um campo de texto (eco concreto §8 — não "atualizada"). */
function preview(text: string): string {
  const t = text.trim().replace(/\s+/gu, " ");
  return t.length <= ECHO_PREVIEW_MAX ? t : `${t.slice(0, ECHO_PREVIEW_MAX - 1)}…`;
}

/** Antes → depois de um campo de texto acumulativo (o dono vê append × replace). */
function textBeforeAfter(before: string | null, after: string | null): string {
  // APPEND: o texto novo entra no FIM. Truncar before→after esconderia justo o que muda
  // (o preview de 140 chars corta antes de chegar no acréscimo). Mostra o DELTA adicionado.
  if (before !== null && after !== null && after.length > before.length && after.startsWith(before)) {
    const added = after.slice(before.length).trim();
    if (added.length > 0) return `mantém o texto atual e ADICIONA: "${preview(added)}"`;
  }
  const b = before === null ? "(vazio)" : `"${preview(before)}"`;
  const a = after === null ? "limpo" : `"${preview(after)}"`;
  return `${b} → ${a}`;
}

/** Linhas de detalhe de UM campo mudado (antes → depois). Vazio = nada a dizer. */
function configDetailLines(
  label: string,
  cur: AgentConfigState,
  next: AgentConfigState,
  currency: string,
): string[] {
  const lines: string[] = [];
  switch (label) {
    case CONFIG_CHANGE_LABELS.goals: {
      if (cur.goals.targetCPA !== next.goals.targetCPA)
        lines.push(`meta de CPA (custo por resultado): ${moneyOrNone(cur.goals.targetCPA, currency)} → ${moneyOrNone(next.goals.targetCPA, currency)}`);
      if (cur.goals.targetROAS !== next.goals.targetROAS)
        lines.push(`meta de ROAS (retorno): ${roasOrNone(cur.goals.targetROAS)} → ${roasOrNone(next.goals.targetROAS)}`);
      if (cur.goals.conversionGoal !== next.goals.conversionGoal)
        lines.push(`resultado de negócio: ${conversionLabel(cur.goals.conversionGoal)} → ${conversionLabel(next.goals.conversionGoal)}`);
      else if (cur.goals.customConversionId !== next.goals.customConversionId)
        lines.push(`conversão personalizada: ${cur.goals.customConversionId ?? "não definida"} → ${next.goals.customConversionId ?? "não definida"}`);
      return lines;
    }
    case CONFIG_CHANGE_LABELS.autonomyPolicy: {
      for (const src of ["playbook", "llm"] as const) {
        const a = cur.autonomyPolicy.bySource[src];
        const b = next.autonomyPolicy.bySource[src];
        if (a !== b)
          lines.push(`autonomia — ${SOURCE_LABEL_PT[src]}: ${AUTONOMY_LABEL_PT[a]} → ${AUTONOMY_LABEL_PT[b]}`);
      }
      return lines;
    }
    case CONFIG_CHANGE_LABELS.guardrails: {
      const g = cur.guardrails;
      const h = next.guardrails;
      if (g.maxBudgetChangePct !== h.maxBudgetChangePct)
        lines.push(`limite de mudança de budget: ${g.maxBudgetChangePct}% → ${h.maxBudgetChangePct}%`);
      if (g.maxEntitiesPerDay !== h.maxEntitiesPerDay)
        lines.push(`máximo de entidades por dia: ${g.maxEntitiesPerDay} → ${h.maxEntitiesPerDay}`);
      if (g.dryRun !== h.dryRun) lines.push(`modo simulação: ${onOff(g.dryRun)} → ${onOff(h.dryRun)}`);
      if (g.killSwitch !== h.killSwitch)
        lines.push(`botão de emergência (kill-switch): ${onOff(g.killSwitch)} → ${onOff(h.killSwitch)}`);
      if (jsonEq(g.allowedActions, h.allowedActions) === false)
        lines.push(`ações permitidas: ${actionsLabel(g.allowedActions)} → ${actionsLabel(h.allowedActions)}`);
      if (g.llmCostCapUsd !== h.llmCostCapUsd)
        lines.push(
          `limite de custo de IA: ${g.llmCostCapUsd == null ? "sem limite" : `US$ ${g.llmCostCapUsd}`} → ${h.llmCostCapUsd == null ? "sem limite" : `US$ ${h.llmCostCapUsd}`}`,
        );
      return lines;
    }
    case CONFIG_CHANGE_LABELS.cadence:
      lines.push(`cadência da análise: ${describeCadence(cur.cadence)} → ${describeCadence(next.cadence)}`);
      return lines;
    case CONFIG_CHANGE_LABELS.analysisWindowDays:
      lines.push(`janela de análise: ${cur.analysisWindowDays} dias → ${next.analysisWindowDays} dias`);
      return lines;
    case CONFIG_CHANGE_LABELS.businessContext:
      lines.push(`contexto do negócio: ${textBeforeAfter(cur.businessContext, next.businessContext)}`);
      return lines;
    case CONFIG_CHANGE_LABELS.guidance:
      lines.push(`orientações ao agente: ${textBeforeAfter(cur.guidance, next.guidance)}`);
      return lines;
    case CONFIG_CHANGE_LABELS.persona:
      lines.push(`persona: ${next.persona === null ? "limpa (volta ao arquétipo)" : `"${preview(next.persona)}"`}`);
      return lines;
    case CONFIG_CHANGE_LABELS.tone:
      lines.push(`tom da comunicação: ${next.tone === null ? "limpo (volta ao arquétipo)" : `"${preview(next.tone)}"`}`);
      return lines;
    case CONFIG_CHANGE_LABELS.systemPrompt:
      lines.push(
        next.systemPrompt === null
          ? "metodologia: limpa (volta à metodologia do arquétipo)"
          : `metodologia (substitui a do arquétipo): "${preview(next.systemPrompt)}"`,
      );
      return lines;
    case CONFIG_CHANGE_LABELS.modelConfig:
      lines.push("limiares avançados: atualizados");
      return lines;
    case CONFIG_CHANGE_LABELS.posture: {
      const c = cur.posture;
      const n = next.posture;
      if (c.experienceLevel !== n.experienceLevel)
        lines.push(`perfil de comunicação: ${experienceLabel(c.experienceLevel)} → ${experienceLabel(n.experienceLevel)}`);
      for (const axis of ["directiveness", "volume", "didacticDepth"] as const) {
        if (c[axis] !== n[axis])
          lines.push(`${POSTURE_AXIS_PT[axis]}: ${postureLevelLabel(axis, c[axis])} → ${postureLevelLabel(axis, n[axis])}`);
      }
      return lines;
    }
    case CONFIG_CHANGE_LABELS.notifyPolicy: {
      const c = cur.notifyPolicy;
      const n = next.notifyPolicy;
      if (c.pulse.enabled !== n.pulse.enabled)
        lines.push(`resumo periódico (pulso): ${onOff(c.pulse.enabled)} → ${onOff(n.pulse.enabled)}`);
      if (jsonEq(c.pulse.cadence, n.pulse.cadence) === false)
        lines.push(`cadência do pulso: ${describeCadence(c.pulse.cadence)} → ${describeCadence(n.pulse.cadence)}`);
      if (c.alerts.enabled !== n.alerts.enabled)
        lines.push(`alerta automático: ${onOff(c.alerts.enabled)} → ${onOff(n.alerts.enabled)}`);
      if (c.alerts.sensitivity !== n.alerts.sensitivity)
        lines.push(`sensibilidade do alerta: ${ALERT_SENSITIVITY_LABEL_PT[c.alerts.sensitivity]} → ${ALERT_SENSITIVITY_LABEL_PT[n.alerts.sensitivity]}`);
      if (c.alerts.throttleHours !== n.alerts.throttleHours)
        lines.push(`intervalo mínimo entre alertas: ${c.alerts.throttleHours}h → ${n.alerts.throttleHours}h`);
      if (c.runPush.enabled !== n.runPush.enabled)
        lines.push(`aviso após cada análise: ${onOff(c.runPush.enabled)} → ${onOff(n.runPush.enabled)}`);
      if ((c.reactivation?.enabled ?? false) !== (n.reactivation?.enabled ?? false))
        lines.push(
          `aviso quando a conta voltar a rodar: ${onOff(c.reactivation?.enabled ?? false)} → ${onOff(n.reactivation?.enabled ?? false)}`,
        );
      const cah = c.accountHealthAlert;
      const nah = n.accountHealthAlert;
      if ((cah?.enabled ?? true) !== (nah?.enabled ?? true))
        lines.push(`aviso de problema na conta Meta: ${onOff(cah?.enabled ?? true)} → ${onOff(nah?.enabled ?? true)}`);
      // compara o texto descrito (não o objeto cru) — evita linha espúria "teto da Meta →
      // teto da Meta" quando o estado legado não tinha o campo e o merge só o backfillou.
      if (describeSpendThreshold(cah, currency) !== describeSpendThreshold(nah, currency))
        lines.push(`teto de gasto que avisa: ${describeSpendThreshold(cah, currency)} → ${describeSpendThreshold(nah, currency)}`);
      if (describeBalanceThreshold(cah, currency) !== describeBalanceThreshold(nah, currency))
        lines.push(`aviso de saldo baixo: ${describeBalanceThreshold(cah, currency)} → ${describeBalanceThreshold(nah, currency)}`);
      const statusChange = describeStatusTriggerChange(cah, nah);
      if (statusChange) lines.push(statusChange);
      return lines;
    }
    default:
      return lines;
  }
}

// ─── Descrição de regra de playbook (chat, S2.5) ────────────────────────────
// PURO: frase de gente de uma regra `condição → ação`, p/ o eco de add/toggle/remove.
// Shape NEUTRO (serve o tool_call do add e a linha do banco no toggle/remove).

/** Métrica da condição em PT (rótulo de gente). */
const PLAYBOOK_METRIC_LABEL_PT: Readonly<Record<string, string>> = {
  cpa: "custo por resultado",
  roas: "ROAS (retorno)",
  spend: "gasto",
  cpc: "custo por clique",
  cpm: "custo por mil impressões",
  ctr: "CTR (taxa de clique)",
  frequency: "frequência",
};

/** Operador da condição em PT. */
const PLAYBOOK_OP_LABEL_PT: Readonly<Record<string, string>> = {
  ">": "acima de",
  "<": "abaixo de",
  ">=": "de pelo menos",
  "<=": "no máximo",
  "==": "igual a",
};

/** Escopo da regra em PT (com artigo). */
const PLAYBOOK_SCOPE_LABEL_PT: Readonly<Record<string, string>> = {
  campaign: "a campanha",
  adset: "o conjunto",
  ad: "o anúncio",
};

/** Formata o valor da condição conforme a métrica (moeda, x, %, número). */
function playbookValueLabel(metric: string, value: number, currency: string): string {
  if (metric === "cpa" || metric === "spend" || metric === "cpc" || metric === "cpm")
    return formatMoney(value, currency);
  if (metric === "roas") return `${value}x`;
  if (metric === "ctr") return `${value}%`;
  return `${value}`;
}

/** Shape NEUTRO de uma regra de playbook (do tool_call do add ou da linha do banco). */
export interface PlaybookRuleDescriptor {
  readonly scope: string;
  readonly metric: string;
  readonly op: string;
  readonly value: number;
  readonly minSpend?: number | null;
  readonly thenType: string;
  readonly budgetChangePct?: number | null;
  readonly status?: string | null;
}

/** Cláusula da AÇÃO (então) de uma regra, em PT. */
function playbookThenLabel(d: PlaybookRuleDescriptor): string {
  switch (d.thenType) {
    case "pause_entity":
      return "pausar";
    case "adjust_budget": {
      const pct = d.budgetChangePct ?? 0;
      const dir = pct >= 0 ? "aumentar" : "reduzir";
      return `${dir} o budget em ${Math.abs(pct)}%`;
    }
    case "set_status":
      return `mudar o status para ${d.status === "active" ? "ativo" : "pausado"}`;
    default:
      return d.thenType;
  }
}

/** Frase de gente de uma regra de playbook (PURA) — base do eco de add/toggle/remove. */
export function describePlaybookRule(d: PlaybookRuleDescriptor, currency: string = DEFAULT_CURRENCY): string {
  const scope = PLAYBOOK_SCOPE_LABEL_PT[d.scope] ?? d.scope;
  const metric = PLAYBOOK_METRIC_LABEL_PT[d.metric] ?? d.metric;
  const op = PLAYBOOK_OP_LABEL_PT[d.op] ?? d.op;
  const value = playbookValueLabel(d.metric, d.value, currency);
  const minSpend = d.minSpend != null ? ` (só com gasto de pelo menos ${formatMoney(d.minSpend, currency)})` : "";
  return `quando ${scope} tiver ${metric} ${op} ${value}${minSpend}, ${playbookThenLabel(d)}`;
}

/** Entrada do eco de mudança de config: estados antes/depois + o diff já computado. */
export interface ConfigChangeEchoInput {
  readonly current: AgentConfigState;
  readonly next: AgentConfigState;
  readonly changed: readonly string[];
  readonly weakensSafety: boolean;
  /** moeda da conta do agente (ISO) — formata metas/limiares em dinheiro. Default = BRL. */
  readonly currency?: string;
}

/** Prefixo de aviso quando a mudança afrouxa a rede de segurança (§8). */
export const CONFIG_WEAKENS_SAFETY_PREFIX = "⚠️ Isso afrouxa sua segurança:";

/**
 * Monta o eco determinístico de uma mudança de config (chat, S2.3). PT, concreto,
 * 1 mudança por linha (antes → depois). Prefixa o aviso de afrouxamento quando
 * `weakensSafety`. Fecha com "Confirma?" (eco+confirma). PURO.
 */
export function buildConfigChangeEcho(input: ConfigChangeEchoInput): string {
  const { current, next, changed, weakensSafety, currency = DEFAULT_CURRENCY } = input;
  const details: string[] = [];
  for (const label of changed) details.push(...configDetailLines(label, current, next, currency));
  if (details.length === 0) return "Não vi nada pra mudar na config.";
  const body = details.length === 1 ? details[0]! : details.map((d, i) => `${i + 1}. ${d}`).join("\n");
  const warn = weakensSafety ? `${CONFIG_WEAKENS_SAFETY_PREFIX}\n` : "";
  return `${warn}Vou atualizar:\n${body}\n\nConfirma?`;
}
