// Nós do grafo `whatsapp-conversation` (ReAct): agent (LLM+tools) ↔ tools, com um
// gate de confirmação humana antes de qualquer ESCRITA (5b-2.3). Na 5b-2.2 só há
// tools de LEITURA + trigger_analysis, então o gate fica inativo (nenhuma write tool).

import { ChatOpenAI } from "@langchain/openai";
import { AIMessage, HumanMessage, SystemMessage, ToolMessage, type BaseMessage } from "@langchain/core/messages";
import { ToolNode } from "@langchain/langgraph/prebuilt";
import type { Logger } from "pino";
import {
  applyGuardrails,
  archetypeDefaults,
  archetypeCatalog,
  autonomyPolicyWeakens,
  buildConfigChangeEcho,
  buildGroupTranscript,
  buildRevertEcho,
  buildWriteEcho,
  describePlaybookRule,
  entityKeyOf,
  resolveAgentConfigChange,
  type EchoItem,
  type RevertEchoItem,
} from "@trafego/core";
import { applyAgentConfigChange, loadAgentConfigState, reseedArchetypeChange } from "@trafego/agent-config";
import { sleep, APPROVAL_APPLY_JOB, APPROVAL_APPLY_QUEUE } from "@trafego/shared";
import type { Action, ConversionGoal, OrgId } from "@trafego/shared/types";
import { CONVERSION_GOALS } from "@trafego/shared/types";
import { and, eq } from "drizzle-orm";
import { adAccounts, agents, playbookRules, type Database } from "@trafego/db";
import { DEFAULT_CURRENCY } from "@trafego/shared";
import type { WorkerDeps } from "../../composition.js";
import { describeLlmError } from "./llm-error.js";
import { GROUP_RULES, loadConversationConfig } from "./system-prompt.js";
import { windowMessages } from "./window.js";
import {
  CONFIG_UPDATE_TOOL_NAMES,
  CONTROL_WRITE_TOOL_NAMES,
  CREATE_TOOL_NAMES,
  REFINE_TOOL_NAMES,
  PLAYBOOK_WRITE_TOOL_NAMES,
  REVERT_TOOL_NAME,
  DESCRIBE_CAPABILITIES_TOOL_NAME,
  RESEED_TOOL_NAME,
  WRITE_TOOL_NAMES,
  actionFromToolCall,
  buildCapabilitiesText,
  isConfirmableConfigTool,
  makeConversationTools,
  mergeConfigUpdatePatches,
  pendingRuleToDescriptor,
  playbookOpFromToolCall,
  ruleRowToDescriptor,
  type ConversationToolContext,
} from "./tools.js";
import { makeMetaToolExecutor } from "../../executors/meta-tools.js";
import { applyCheckedAction, type ApplyOutcome } from "../../modules/apply/apply-confirmed-action.js";
import { proposeCreateCampaign, proposeScaleWinner, refineDraft } from "../../modules/conversation/draft-proposal.js";
import { loadWriteContext } from "../../modules/apply/write-context.js";
import { revertActionById } from "../../modules/apply/revert-action.js";
import { actorLabel } from "../../modules/conversation/actor.js";
import { createNotifyRepo } from "../../modules/notify/repo.js";
import { applyPlaybookOp } from "../../modules/conversation/config-writes.js";
import type {
  PendingConfigChange,
  PendingDraft,
  PendingRevert,
  PendingWrite,
  WhatsappConversationStateType,
  WhatsappConversationUpdate,
} from "./state.js";

const CONVERSATION_TEMPERATURE = 0.3;

/** Guard: `v` é um ConversionGoal da taxonomia neutra (o LLM manda goal como texto livre). */
function isConversionGoal(v: unknown): v is ConversionGoal {
  return typeof v === "string" && (CONVERSION_GOALS as readonly string[]).includes(v);
}

const MS_PER_HOUR = 60 * 60 * 1000;
/** Rótulo do bot no transcript ambiente (outbound no transcript = fast-follow; hoje sem uso real). */
const GROUP_BOT_LABEL = "Assistente";

const ECHO_INTRO = "\n\nHá algo que você já propôs e que aguarda a confirmação do usuário:\n";
const ECHO_OUTRO =
  '\n\nSe a última mensagem do usuário confirmar claramente (ex: "sim", "pode", "manda"), chame confirm_write. Se recusar, chame cancel_write. Se pedir mudança/outra coisa, IGNORE a pendência e trate normalmente.';

/**
 * Monta o system prompt do turno: voz do agente + (grupo) bloco de contexto ambiente +
 * (pendência) eco+confirma. PURA. Em DM `groupBlock` é "" → o prompt é IDÊNTICO ao de antes
 * do contexto de grupo (regressão garantida por construção: "" cai no ramo `else`).
 */
export function assembleSystemPrompt(systemPrompt: string, groupBlock: string, echo: string | undefined): string {
  const base = groupBlock ? `${systemPrompt}\n\n${groupBlock}` : systemPrompt;
  return echo ? `${base}${ECHO_INTRO}${echo}${ECHO_OUTRO}` : base;
}

/** TTL do eco+confirma: um "sim" muito depois não aplica uma ação esquecida (§8). */
const PENDING_WRITE_TTL_MS = 30 * 60 * 1000;

/**
 * Moeda (ISO) da conta do agente — o eco de config (meta de CPA, minSpend/valor de
 * playbook) formata dinheiro nela (currency-aware, pivô B2B/B2C). Conta sem moeda ou
 * agente órfão → default. Leitura leve (1 join), no baixo volume do chat.
 */
async function loadAgentAccountCurrency(db: Database, orgId: string, agentId: string): Promise<string> {
  const [row] = await db
    .select({ currency: adAccounts.currency })
    .from(agents)
    .innerJoin(adAccounts, and(eq(agents.adAccountId, adAccounts.id), eq(adAccounts.orgId, orgId)))
    .where(and(eq(agents.id, agentId), eq(agents.orgId, orgId)))
    .limit(1);
  return row?.currency ?? DEFAULT_CURRENCY;
}

/** ToolMessage p/ cada tool_call (mantém o histórico válido). Primeiro leva o texto; resto, eco curto. */
function answerToolCalls(calls: readonly { id?: string }[], text: string): ToolMessage[] {
  return calls.map((c, i) => new ToolMessage({ content: i === 0 ? text : "(ver acima)", tool_call_id: c.id ?? "" }));
}

/** pendingWrite ainda válido (não expirado)? */
function activePendingWrite(pw: PendingWrite | null): PendingWrite | null {
  return pw && Date.parse(pw.expiresAt) > Date.now() ? pw : null;
}

/** pendingRevert ainda válido (não expirado)? */
function activePendingRevert(pr: PendingRevert | null): PendingRevert | null {
  return pr && Date.parse(pr.expiresAt) > Date.now() ? pr : null;
}

/** pendingDraft ainda válido (não expirado)? */
function activePendingDraft(pd: PendingDraft | null): PendingDraft | null {
  return pd && Date.parse(pd.expiresAt) > Date.now() ? pd : null;
}

/** pendingConfigChange ainda válido (não expirado)? */
function activePendingConfig(pc: PendingConfigChange | null): PendingConfigChange | null {
  return pc && Date.parse(pc.expiresAt) > Date.now() ? pc : null;
}

/** Oferta de rodar a análise após uma mudança relevante (NÃO dispara sozinho — §8). */
const RUN_ANALYSIS_OFFER = "Quer que eu rode uma análise agora com a nova config?";

/** Nível de autonomia em PT (3ª pessoa) — p/ o eco do reseed. */
const AUTONOMY_LABEL_PT: Readonly<Record<string, string>> = {
  notify: "só avisa",
  suggest: "sugere e pede OK",
  act_safe: "age no seguro",
  act_full: "age sozinho",
};

const PAST_PHRASE: Record<string, (name: string) => string> = {
  pause_entity: (n) => `Pausei ${n}`,
  resume_entity: (n) => `Reativei ${n}`,
  set_status: (n) => `Atualizei ${n}`,
  adjust_budget: (n) => `Ajustei o budget de ${n}`,
};

/** Linha de desfecho de UMA ação aplicada (voz determinística, §UX). */
function outcomeLine(action: Action, outcome: ApplyOutcome): string {
  const name = action.target.name ?? action.target.id;
  switch (outcome.kind) {
    case "applied":
      return outcome.dryRun
        ? `🧪 Simulei em ${name} (dry-run, não apliquei de verdade).`
        : `✅ ${(PAST_PHRASE[action.type] ?? ((x: string) => `Mexi em ${x}`))(name)}.`;
    case "noop":
      return `Não precisei mexer em ${name} — já estava assim.`;
    case "blocked":
      return `Não consegui em ${name}: ${outcome.reason}.`;
    case "failed":
      return `Não consegui aplicar em ${name} agora — a Meta não respondeu. Tenta de novo.`;
  }
}

/** Extrai tokens/custo da resposta do ChatOpenAI (OpenRouter com usage.include). */
function usageOf(msg: AIMessage): { inputTokens?: number; outputTokens?: number; costUsd?: number } {
  const u = msg.usage_metadata;
  const meta = msg.response_metadata as Record<string, unknown> | undefined;
  const cost = (meta?.["usage"] as Record<string, unknown> | undefined)?.["cost"];
  return {
    ...(u?.input_tokens != null ? { inputTokens: u.input_tokens } : {}),
    ...(u?.output_tokens != null ? { outputTokens: u.output_tokens } : {}),
    ...(typeof cost === "number" ? { costUsd: cost } : {}),
  };
}

/**
 * O OpenRouter indexa a generation de forma assíncrona no lado dele — buscar
 * `GET /generation?id=` logo após a chamada dá 404 garantido, e o atraso
 * observado é VARIÁVEL (medido entre ~3s e ~10s+, não um valor fixo). Por isso
 * o patch de custo é background/fire-and-forget (nunca no caminho síncrono do
 * turno) e faz várias tentativas espaçadas em vez de 1 tiro só.
 */
const COST_PATCH_INITIAL_DELAY_MS = 3_000;
const COST_PATCH_RETRY_DELAY_MS = 3_000;
const COST_PATCH_MAX_ATTEMPTS = 5; // pior caso: 3s + 4×(3s espera + 3s timeout HTTP) ≈ 27s, sempre em background

/** Precisa do fallback assíncrono de custo? Só quando faltou E há id pra consultar. */
export function needsCostFallback(
  usage: { costUsd?: number },
  generationId: string | undefined,
): generationId is string {
  return usage.costUsd === undefined && !!generationId;
}

export interface CostPatchInput {
  readonly usageEventId: string;
  readonly generationId: string;
  readonly fetchGenerationCost: (generationId: string) => Promise<number | undefined>;
  readonly updateCost: (id: string, costUsd: number) => Promise<void>;
  readonly logger: Pick<Logger, "debug">;
  /** injetável p/ teste (evita esperar os ~27s reais). */
  readonly sleepFn?: (ms: number) => Promise<void>;
}

/**
 * Enriquece o custo de uma linha de `usage_events` já gravada, em BACKGROUND
 * (fire-and-forget — nunca bloqueia o turno/resposta do WhatsApp). Espera o
 * OpenRouter indexar a generation, busca o custo por id e faz o PATCH. Nunca
 * lança: falha (ainda não indexado, rede, etc.) = linha fica sem custo, mesma
 * convenção de "custo ausente ≠ zero" do resto do metering.
 */
export async function patchCostInBackground(input: CostPatchInput): Promise<void> {
  const { usageEventId, generationId, fetchGenerationCost, updateCost, logger, sleepFn = sleep } = input;
  try {
    await sleepFn(COST_PATCH_INITIAL_DELAY_MS);
    for (let attempt = 0; attempt < COST_PATCH_MAX_ATTEMPTS; attempt += 1) {
      const costUsd = await fetchGenerationCost(generationId);
      if (costUsd !== undefined) {
        await updateCost(usageEventId, costUsd);
        return;
      }
      if (attempt < COST_PATCH_MAX_ATTEMPTS - 1) await sleepFn(COST_PATCH_RETRY_DELAY_MS);
    }
  } catch (err) {
    logger.debug({ err }, "conversation:cost-patch falhou (best-effort)");
  }
}

/**
 * Jobs de `patchCostInBackground` em voo — rastreados só p/ o worker conseguir
 * esperá-los (com teto) no shutdown gracioso (ver `drainPendingCostPatches` em
 * `main.ts`); nunca são aguardados no caminho síncrono do turno.
 */
const pendingCostPatches = new Set<Promise<void>>();

/** Dispara `patchCostInBackground` sem bloquear o turno, rastreando a promise p/ o shutdown. */
export function scheduleCostPatch(input: CostPatchInput): void {
  const job = patchCostInBackground(input).finally(() => pendingCostPatches.delete(job));
  pendingCostPatches.add(job);
}

const DRAIN_TIMEOUT_MS = 20_000;

/**
 * Espera os patches de custo em voo (com teto) — chamado no shutdown gracioso
 * do worker p/ não perder o fallback assíncrono em todo deploy/restart. Nunca
 * lança: é best-effort, igual ao patch em si.
 */
export async function drainPendingCostPatches(timeoutMs = DRAIN_TIMEOUT_MS): Promise<void> {
  if (pendingCostPatches.size === 0) return;
  await Promise.race([Promise.allSettled([...pendingCostPatches]), sleep(timeoutMs)]);
}

/**
 * Registra o custo da chamada de LLM da conversa (§11). Não passa pelo
 * decorator `withLlmMetering` porque este grafo fala com o `ChatOpenAI`
 * (LangChain, com `.bindTools()`) direto — não pelo `LLMProviderPort`, que
 * hoje não modela tool-calling. Monta o `usage_event` à mão por isso; se o
 * formato mudar, revisar os dois lugares (aqui e o decorator).
 */
async function recordConversationUsage(
  deps: WorkerDeps,
  ctx: ConversationToolContext,
  model: string,
  response: AIMessage,
): Promise<void> {
  const usage = usageOf(response);
  try {
    const usageEventId = await deps.ports.metering.record({
      orgId: ctx.orgId as OrgId,
      // atribui o custo do chat à conta em foco/contexto (Fatia 6c) — sai do balde
      // "sem conta"; concierge sem foco → adAccountId ausente (fica org-only).
      ...(ctx.adAccountId ? { adAccountId: ctx.adAccountId } : {}),
      type: "conversation",
      provider: "openrouter",
      model,
      ...usage,
      payload: { actor: actorLabel(ctx.ref), conversationId: ctx.conversationId },
    });
    if (needsCostFallback(usage, response.id)) {
      // fire-and-forget: o custo chega depois (patch), a resposta não espera.
      scheduleCostPatch({
        usageEventId,
        generationId: response.id,
        fetchGenerationCost: deps.conversation.fetchGenerationCost,
        updateCost: (id, costUsd) => deps.ports.metering.updateCost(ctx.orgId as OrgId, id, costUsd),
        logger: deps.logger,
      });
    }
  } catch (err) {
    deps.logger.warn({ err }, "conversation:metering falhou");
  }
}

/**
 * Aplica a mudança de CONFIG congelada (S2.3–S2.6): update (reusa @trafego/agent-config,
 * fonte única com o site) / reseed / playbook. O ator da trilha é o CONTATO. Oferece rodar
 * a análise quando a mudança é relevante (NÃO dispara sozinho — §8). Erro → resposta honesta.
 */
async function applyConfirmedConfig(
  deps: WorkerDeps,
  ctx: ConversationToolContext,
  pending: PendingConfigChange,
): Promise<string> {
  const orgId = ctx.orgId as OrgId;
  // ator = o contato que falou no WhatsApp (mesma trilha do executor de escrita — §12/§13);
  // canal na trilha p/ paridade com o audit de playbook (S2: metadata.channel="whatsapp").
  const audit = { actor: { label: actorLabel(ctx.ref) }, metadata: { channel: "whatsapp" } };
  const offerIfRelevant = (base: string) => (pending.runRelevantChanged ? `${base}\n\n${RUN_ANALYSIS_OFFER}` : base);

  if (pending.kind === "update" && pending.patch) {
    // guard de frescura (S2.3): se o patch toca a segurança, re-lê o estado FRESCO e
    // aborta se (a) a auto-config foi desligada ou (b) guardrails/autonomia mudaram
    // desde o eco — senão o patch absoluto congelado reverteria em silêncio um
    // endurecimento concorrente (§8: a ação confirmada tem de ser a que foi ecoada).
    if (pending.securityBaseline) {
      const fresh = await loadAgentConfigState(deps.db, orgId, ctx.agentId);
      if (fresh && fresh.autonomyPolicy.autoConfigViaChat === false) {
        return "A configuração por chat foi desligada nesta conta — isso agora é pelo site.";
      }
      if (
        fresh &&
        (JSON.stringify(fresh.guardrails) !== JSON.stringify(pending.securityBaseline.guardrails) ||
          JSON.stringify(fresh.autonomyPolicy) !== JSON.stringify(pending.securityBaseline.autonomyPolicy))
      ) {
        return "Sua configuração de segurança mudou desde que preparei isso — pra não desfazer nada sem querer, me pede a mudança de novo.";
      }
    }
    const res = await applyAgentConfigChange(
      { db: deps.db, scheduler: deps.ports.scheduler },
      { orgId, agentId: ctx.agentId, accountId: ctx.adAccountId, patch: pending.patch, audit },
    );
    if (!res.ok) return res.error;
    return offerIfRelevant(`Pronto, atualizei: ${res.changed.join(", ")}.`);
  }
  if (pending.kind === "reseed" && pending.archetype) {
    const res = await reseedArchetypeChange(
      { db: deps.db, scheduler: deps.ports.scheduler },
      { orgId, agentId: ctx.agentId, accountId: ctx.adAccountId, archetype: pending.archetype, audit },
    );
    if (!res.ok) return res.error;
    return offerIfRelevant(`Pronto, resetei o agente pro arquétipo ${archetypeDefaults(res.archetype).label}.`);
  }
  if (pending.kind === "playbook" && pending.playbook) {
    const res = await applyPlaybookOp(deps, { orgId: ctx.orgId, agentId: ctx.agentId, actor: actorLabel(ctx.ref), op: pending.playbook });
    return res.ok ? offerIfRelevant(res.message) : res.message;
  }
  return "Não consegui aplicar a mudança de config — me diz de novo o que você quer?";
}

export function makeConversationNodes(
  deps: WorkerDeps,
  ctx: ConversationToolContext,
  allow: ReadonlySet<string>,
) {
  const { logger } = deps;
  const tools = makeConversationTools(deps, ctx, allow);

  const executor = makeMetaToolExecutor(deps);

  // Seção de GRUPO (group-only, efêmera): regras do grupo (S5) + transcript ambiente (S2),
  // montada UMA vez por turno (cache no closure — o nó `agent` roda várias vezes no laço
  // ReAct) e injetada no system prompt. Em DM devolve "" → prompt idêntico. As regras entram
  // SEMPRE (mesmo sem transcript ainda); o transcript se soma quando há histórico. NÃO vai ao
  // checkpointer/state.
  const groupRepo = createNotifyRepo(deps.db);
  let groupSectionCache: string | null = null;
  async function groupSection(): Promise<string> {
    if (ctx.ref.kind !== "group") return "";
    if (groupSectionCache !== null) return groupSectionCache;
    const conv = deps.conversation;
    const now = new Date();
    const since = new Date(now.getTime() - conv.groupContextWindowHours * MS_PER_HOUR);
    const sources = await groupRepo.loadGroupTranscriptSources(
      ctx.orgId,
      ctx.ref.groupId,
      since,
      conv.groupContextMaxMessages,
      ctx.ref.participantPhone, // exclui as dirigidas do próprio participante (já no state.messages)
    );
    const transcript = buildGroupTranscript(sources, {
      now,
      windowHours: conv.groupContextWindowHours,
      maxMessages: conv.groupContextMaxMessages,
      maxTokens: conv.groupContextMaxTokens,
      botLabel: GROUP_BOT_LABEL,
      tz: ctx.timezone,
    });
    groupSectionCache = transcript ? `${GROUP_RULES}\n\n${transcript}` : GROUP_RULES;
    return groupSectionCache;
  }

  /** Nova instância de chat LLM (OpenRouter). `withTools` liga as tools da allowlist. */
  function makeChat(model: string, withTools: boolean) {
    const chat = new ChatOpenAI({
      model,
      apiKey: deps.conversation.apiKey,
      configuration: { baseURL: deps.conversation.baseUrl },
      temperature: CONVERSATION_TEMPERATURE,
      // timeout por chamada + retries: sem isto uma call travada no provider (OpenRouter
      // roteando p/ provider lento/instável) só é cortada pelo teto de 90s do turno, que
      // vira o fallback "não consegui processar". Com timeout curto + retry, o SDK reroteia.
      timeout: deps.conversation.httpTimeoutMs,
      maxRetries: deps.conversation.maxRetries,
      // OpenRouter devolve custo real quando pedimos usage — essencial p/ o billing (§11).
      // Com .bindTools(), o @langchain/openai suprime response_metadata.usage (custo some)
      // — patchCostInBackground() cobre com fallback assíncrono (nunca bloqueia a resposta).
      modelKwargs: { usage: { include: true } },
    });
    return withTools ? chat.bindTools(tools) : chat;
  }

  /** Nó ReAct: LLM (OpenRouter) com as tools da allowlist + voz do agente. */
  async function agent(state: WhatsappConversationStateType): Promise<WhatsappConversationUpdate> {
    logger.debug({ actor: actorLabel(ctx.ref) }, "conversation:agent");
    const { systemPrompt, model } = await loadConversationConfig(
      deps.db,
      ctx.orgId,
      ctx.agentId.length > 0 ? ctx.agentId : null,
      deps.conversation.model,
      ctx.configViaChat ?? false,
    );

    // eco+confirma (5c): se há ação/reversão pendente válida, oriente o LLM a só
    // CLASSIFICAR a intenção (confirm_write/cancel_write) — o que se aplica é o congelado.
    const pending = activePendingWrite(state.pendingWrite);
    const pendingRevert = activePendingRevert(state.pendingRevert);
    const pendingConfig = activePendingConfig(state.pendingConfigChange);
    const echo = pending?.echo ?? pendingRevert?.echo ?? pendingConfig?.echo;

    // seção de grupo (regras + contexto ambiente; group-only, efêmera, entre a voz e o eco). DM → "".
    const sys = assembleSystemPrompt(systemPrompt, await groupSection(), echo);

    const windowed = windowMessages(state.messages, {
      maxTurns: deps.conversation.historyTurns,
      maxTokens: deps.conversation.maxTokens,
    });
    const msgs = [new SystemMessage(sys), ...windowed];
    // Primário com retry/backoff (ChatOpenAI.maxRetries); se ESGOTAR, tenta o RESERVA
    // (também com retry/backoff). Loga cada ponto de falha. Provider diverso = resiliência a blip.
    const fallback = deps.conversation.fallbackModel;
    let response: AIMessage;
    let usedModel = model;
    try {
      response = (await makeChat(model, true).invoke(msgs)) as AIMessage;
    } catch (err) {
      if (!fallback || fallback === model) {
        logger.error({ actor: actorLabel(ctx.ref), model, err: describeLlmError(err) }, "conversation:LLM falhou (sem reserva)");
        throw err;
      }
      logger.warn(
        { actor: actorLabel(ctx.ref), model, fallback, err: describeLlmError(err) },
        "conversation:LLM primário esgotou — tentando reserva",
      );
      usedModel = fallback;
      try {
        response = (await makeChat(fallback, true).invoke(msgs)) as AIMessage;
      } catch (err2) {
        logger.error(
          { actor: actorLabel(ctx.ref), model, fallback, err: describeLlmError(err2) },
          "conversation:LLM primário E reserva falharam",
        );
        throw err2;
      }
    }
    await recordConversationUsage(deps, ctx, usedModel, response);

    // limpa pendências expiradas (o "sim" tardio não aplica algo esquecido).
    const update: WhatsappConversationUpdate = { messages: [response] };
    if (state.pendingWrite && !pending) update.pendingWrite = null;
    if (state.pendingRevert && !pendingRevert) update.pendingRevert = null;
    if (state.pendingConfigChange && !pendingConfig) update.pendingConfigChange = null;
    return update;
  }

  /** Executa as tools de leitura escolhidas pelo modelo (escrita passa pelo gate). */
  function toolsNode() {
    return new ToolNode(tools);
  }

  /**
   * Gate de ECO+CONFIRMA antes de QUALQUER escrita (CLAUDE §8, 5c). Roda guardrail
   * (clamp/drop) + dry-run SEM PERSISTIR (ports.ads.mutate direto — o executor persistiria
   * agent_tool_calls até em dry-run), monta o eco determinístico do que VAI acontecer e
   * congela as ações clampadas em `pendingWrite`. Nada é escrito na Meta aqui.
   */
  async function confirmWriteGate(state: WhatsappConversationStateType): Promise<WhatsappConversationUpdate> {
    const last = state.messages.at(-1) as AIMessage | undefined;
    const allCalls = last?.tool_calls ?? [];

    // DESCRIBE_CAPABILITIES: emite o texto HONESTO VERBATIM (o LLM parafraseava e dropava
    // linhas de limitação, ex: "config é pelo site"). É informativo puro — não coexiste com escrita.
    const describeCall = allCalls.find((c) => c.name === DESCRIBE_CAPABILITIES_TOOL_NAME);
    if (describeCall) {
      const text = await buildCapabilitiesText(deps, ctx, allow);
      return { messages: [...answerToolCalls(allCalls, "capabilities"), new AIMessage(text)] };
    }

    // REFINAMENTO conversacional (Fatia 7): ajusta/regenera o rascunho PENDENTE sem criar
    // outro — muta o campaign_drafts + re-ecoa; o "sim" segue aplicando o MESMO rascunho.
    const refineCall = allCalls.find((c) => REFINE_TOOL_NAMES.has(c.name));
    if (refineCall) {
      const active = activePendingDraft(state.pendingDraft);
      if (!active) {
        return { messages: [...answerToolCalls(allCalls, "sem rascunho"), new AIMessage("Não tenho um rascunho aberto pra ajustar. Me diz o que quer criar/escalar primeiro.")] };
      }
      const a = (refineCall.args ?? {}) as Record<string, unknown>;
      const patch =
        refineCall.name === "regenerate_copy"
          ? { regenerateCopy: true }
          : {
              ...(typeof a["budgetReais"] === "number" ? { budgetReais: a["budgetReais"] as number } : {}),
              ...(a["activation"] === "active" || a["activation"] === "paused" ? { activation: a["activation"] as "active" | "paused" } : {}),
              ...(typeof a["variantsCount"] === "number" ? { variantsCount: a["variantsCount"] as number } : {}),
            };
      const res = await refineDraft(deps, { orgId: ctx.orgId, agentId: ctx.agentId, adAccountId: ctx.adAccountId, currency: DEFAULT_CURRENCY }, active.draftId, patch);
      if (res.kind === "blocked") {
        return { messages: [...answerToolCalls(allCalls, "não deu"), new AIMessage(res.reason)] };
      }
      return {
        messages: [...answerToolCalls(allCalls, "ajustado — aguardando confirmação"), new AIMessage(res.echo)],
        pendingDraft: { ...active, echo: res.echo, expiresAt: new Date(Date.now() + PENDING_WRITE_TTL_MS).toISOString() },
      };
    }

    // CRIAÇÃO (Fatia 7): escalar/criar = gasto novo. Monta o rascunho (persiste
    // campaign_drafts + approval na hora → visível no site) + eco; o "sim" enfileira a saga.
    // scale_winner pode virar uma AÇÃO adjust_budget (passo pequeno) → pendingWrite normal.
    const createCall = allCalls.find((c) => CREATE_TOOL_NAMES.has(c.name));
    if (createCall) {
      const dctx = { orgId: ctx.orgId, agentId: ctx.agentId, adAccountId: ctx.adAccountId, currency: DEFAULT_CURRENCY };
      const args = (createCall.args ?? {}) as Record<string, unknown>;
      const proposal =
        createCall.name === "scale_winner"
          ? await proposeScaleWinner(deps, dctx, typeof args["winnerName"] === "string" ? (args["winnerName"] as string) : undefined)
          : await proposeCreateCampaign(deps, dctx, {
              // valida o goal contra a taxonomia neutra ANTES de propor: goal inválido (o LLM
              // manda texto livre) descartado → o propose infere da meta/conta, e o eco mostra
              // o objetivo REAL. Sem isso, um goal fora do enum viraria DEFAULT_OBJECTIVE no
              // adapter, criando campanha (gasto real) com objetivo diferente do prometido (§8).
              ...(isConversionGoal(args["goal"]) ? { goal: args["goal"] } : {}),
              ...(typeof args["budgetReais"] === "number" ? { budgetReais: args["budgetReais"] as number } : {}),
            });
      const expiresAt = new Date(Date.now() + PENDING_WRITE_TTL_MS).toISOString();
      if (proposal.kind === "blocked") {
        return { messages: [...answerToolCalls(allCalls, "não deu"), new AIMessage(proposal.reason)] };
      }
      if (proposal.kind === "draft") {
        return {
          messages: [...answerToolCalls(allCalls, "proposto — aguardando confirmação"), new AIMessage(proposal.echo)],
          pendingDraft: { echo: proposal.echo, expiresAt, approvalId: proposal.approvalId, draftId: proposal.draftId },
          pendingWrite: null,
          pendingRevert: null,
          pendingConfigChange: null,
        };
      }
      // scale raise → ação adjust_budget (guardrail re-checa no applyWrite).
      const echo = `Vou escalar subindo o budget: ${proposal.action.reason}. Confirma?`;
      return {
        messages: [...answerToolCalls(allCalls, "proposto — aguardando confirmação"), new AIMessage(echo)],
        pendingWrite: { echo, expiresAt, actions: [proposal.action] },
        pendingDraft: null,
        pendingRevert: null,
        pendingConfigChange: null,
      };
    }

    // DESFAZER (5c-4): eco de reversão + congela pendingRevert. A ação real (por id) é
    // aplicada no applyWrite; aqui só monta o eco (rótulos vêm do find_recent_actions).
    const revertCalls = allCalls.filter((c) => c.name === REVERT_TOOL_NAME);
    if (revertCalls.length > 0) {
      const items: RevertEchoItem[] = [];
      const ids: string[] = [];
      for (const c of revertCalls) {
        const a = (c.args ?? {}) as { toolCallId?: string; label?: string; actionType?: string };
        if (!a.toolCallId) continue;
        items.push({ label: a.label ?? "essa ação", actionType: a.actionType ?? "" });
        ids.push(a.toolCallId);
      }
      if (ids.length === 0) {
        return { messages: answerToolCalls(allCalls, "Não entendi qual ação desfazer. Use find_recent_actions.") };
      }
      const echo = buildRevertEcho(items);
      return {
        // eco DETERMINÍSTICO direto (sem voz-leve por LLM — um modelo pequeno parafraseia e
        // pode omitir dados/segurança do eco; validação ao vivo confirmou o risco). O eco é a
        // verdade fixa; o ToolMessage só satisfaz o par tool_call/result.
        messages: [...answerToolCalls(allCalls, "proposto — aguardando confirmação"), new AIMessage(echo)],
        pendingRevert: { echo, expiresAt: new Date(Date.now() + PENDING_WRITE_TTL_MS).toISOString(), toolCallIds: ids },
        pendingWrite: null, // uma pendência por vez (write × revert não coexistem)
      };
    }

    // CONFIG POR CHAT (S2.3–S2.6): ramo próprio ANTES da escrita Meta (config não toca a
    // Meta → sem guardrail/dry-run de ads). Monta o eco determinístico + congela a mudança.
    const configCalls = allCalls.filter((c) => isConfirmableConfigTool(c.name));
    if (configCalls.length > 0) {
      // config + escrita Meta no MESMO turno: não engula a escrita em silêncio — peça
      // uma coisa de cada vez (o gate trata 1 pendência por turno). §UX: nunca sumir com o pedido.
      const alsoMetaWrite = allCalls.some((c) => WRITE_TOOL_NAMES.has(c.name) || c.name === REVERT_TOOL_NAME);
      if (alsoMetaWrite) {
        return {
          messages: answerToolCalls(
            allCalls,
            "Você pediu uma mudança de config e uma ação na campanha juntas. Me peça uma de cada vez — qual você quer primeiro?",
          ),
        };
      }
      // Multi-intenção: updates de config (meta/autonomia/guardrail/cadência/identidade) COMBINAM
      // num único eco+confirma (§B3: "muda a meta E a cadência" persiste as duas num "sim"). Já
      // reseed/playbook são pendências distintas que não fundem — misturar tipos (ou 2+ especiais)
      // = uma de cada vez (nunca sumir com o pedido, §UX).
      const updateCalls = configCalls.filter((c) => CONFIG_UPDATE_TOOL_NAMES.has(c.name));
      const specialCalls = configCalls.filter((c) => !CONFIG_UPDATE_TOOL_NAMES.has(c.name));
      if (specialCalls.length > 1 || (specialCalls.length >= 1 && updateCalls.length >= 1)) {
        return {
          messages: answerToolCalls(
            allCalls,
            "Você pediu mais de uma mudança de config de uma vez. Me peça uma de cada vez — qual você quer primeiro?",
          ),
        };
      }
      const call = configCalls[0]!;
      const expiresAt = new Date(Date.now() + PENDING_WRITE_TTL_MS).toISOString();

      // ── UPDATE (meta/autonomia/guardrail/cadência/identidade): resolve SEM persistir. Funde
      //    TODOS os set_* do turno num patch só (multi-campo → um eco → um "sim").
      if (updateCalls.length >= 1) {
        const cur = await loadAgentConfigState(deps.db, ctx.orgId as OrgId, ctx.agentId);
        if (!cur) {
          return { messages: answerToolCalls(allCalls, "Não consegui carregar a config agora. Tenta de novo em instantes.") };
        }
        const patch = mergeConfigUpdatePatches(updateCalls, cur);
        if (!patch) {
          return { messages: answerToolCalls(allCalls, "Não entendi essa mudança de config. Pode dizer de outro jeito?") };
        }
        const resolution = resolveAgentConfigChange(cur, patch);
        // erro do resolver (ex: conversão personalizada sem id) → resposta honesta em PT.
        if (resolution.error) return { messages: answerToolCalls(allCalls, resolution.error) };
        if (resolution.changed.length === 0) {
          return { messages: answerToolCalls(allCalls, "Isso já está assim — não mudei nada.") };
        }
        const echo = buildConfigChangeEcho({
          current: cur,
          next: resolution.next,
          changed: resolution.changed,
          weakensSafety: resolution.weakensSafety,
          currency: await loadAgentAccountCurrency(deps.db, ctx.orgId, ctx.agentId),
        });
        // foto da config de segurança quando o patch a toca → o apply aborta se mudou
        // desde o eco (evita reverter em silêncio um endurecimento concorrente).
        const touchesSecurity = patch.guardrails !== undefined || patch.autonomyPolicy !== undefined;
        return {
          messages: [...answerToolCalls(allCalls, "proposto — aguardando confirmação"), new AIMessage(echo)],
          pendingConfigChange: {
            echo,
            expiresAt,
            kind: "update",
            patch,
            ...(touchesSecurity ? { securityBaseline: { guardrails: cur.guardrails, autonomyPolicy: cur.autonomyPolicy } } : {}),
            weakensSafety: resolution.weakensSafety,
            runRelevantChanged: resolution.runRelevantChanged,
          },
          pendingWrite: null,
          pendingRevert: null,
        };
      }

      // ── RESEED de arquétipo: reseta pros defaults do preset. Avisa se a autonomia SOBE
      //    (o preset pode deixar o agente mais autônomo — §8 exige o aviso de afrouxamento).
      if (call.name === RESEED_TOOL_NAME) {
        const key = String((call.args as { archetype?: string } | undefined)?.archetype ?? "");
        const known = archetypeCatalog().find((a) => a.key === key);
        if (!known) {
          const opts = archetypeCatalog().map((a) => `${a.label} (${a.key})`).join(", ");
          return { messages: answerToolCalls(allCalls, `Não conheço esse arquétipo. Os disponíveis são: ${opts}.`) };
        }
        const cur = await loadAgentConfigState(deps.db, ctx.orgId as OrgId, ctx.agentId);
        if (!cur) {
          return { messages: answerToolCalls(allCalls, "Não consegui carregar a config agora. Tenta de novo em instantes.") };
        }
        const target = archetypeDefaults(known.key).autonomyPolicy;
        const weakens = autonomyPolicyWeakens(cur.autonomyPolicy, target);
        const autoLines = (["playbook", "llm"] as const)
          .filter((s) => cur.autonomyPolicy.bySource[s] !== target.bySource[s])
          .map((s) => `- autonomia (${s === "playbook" ? "regras" : "IA"}): ${AUTONOMY_LABEL_PT[cur.autonomyPolicy.bySource[s]]} → ${AUTONOMY_LABEL_PT[target.bySource[s]]}`);
        const warn = weakens ? "⚠️ Isso afrouxa sua segurança.\n" : "";
        const echo = `${warn}Vou resetar o agente pro arquétipo *${known.label}*: volta persona, tom, metodologia e autonomia pros padrões desse preset (mantém sua meta, contexto e orientações).${autoLines.length > 0 ? `\n${autoLines.join("\n")}` : ""}\n\nConfirma?`;
        return {
          messages: [...answerToolCalls(allCalls, "proposto — aguardando confirmação"), new AIMessage(echo)],
          pendingConfigChange: { echo, expiresAt, kind: "reseed", archetype: known.key, weakensSafety: weakens, runRelevantChanged: true },
          pendingWrite: null,
          pendingRevert: null,
        };
      }

      // ── PLAYBOOK (add/toggle/remove): eco em linguagem de gente + congela a operação.
      if (PLAYBOOK_WRITE_TOOL_NAMES.has(call.name)) {
        const op = playbookOpFromToolCall(call.name, (call.args ?? {}) as Record<string, unknown>);
        if (!op) {
          return { messages: answerToolCalls(allCalls, "Não entendi a regra. Me diz de novo o que ela deve fazer?") };
        }
        const currency = await loadAgentAccountCurrency(deps.db, ctx.orgId, ctx.agentId);
        let echo: string;
        if (op.kind === "add" && op.rule) {
          echo = `Vou criar esta regra no playbook:\n${describePlaybookRule(pendingRuleToDescriptor(op.rule), currency)}\n\nConfirma?`;
        } else {
          const [row] = await deps.db
            .select()
            .from(playbookRules)
            .where(and(eq(playbookRules.id, op.ruleId ?? ""), eq(playbookRules.agentId, ctx.agentId), eq(playbookRules.orgId, ctx.orgId)))
            .limit(1);
          if (!row) {
            return { messages: answerToolCalls(allCalls, "Não achei essa regra. Vê a lista de regras (list_playbook_rules) e me diz qual.") };
          }
          const desc = describePlaybookRule(ruleRowToDescriptor(row), currency);
          const verb = op.kind === "remove" ? "remover" : op.enabled ? "ligar" : "desligar";
          echo = `Vou ${verb} esta regra:\n${desc}\n\nConfirma?`;
        }
        return {
          messages: [...answerToolCalls(allCalls, "proposto — aguardando confirmação"), new AIMessage(echo)],
          pendingConfigChange: { echo, expiresAt, kind: "playbook", playbook: op, weakensSafety: false, runRelevantChanged: true },
          pendingWrite: null,
          pendingRevert: null,
        };
      }
    }

    // id do tool_call como id da ação (idempotência); índice desempata se faltar (raro).
    const proposed = allCalls
      .filter((c) => WRITE_TOOL_NAMES.has(c.name))
      .map((c, i) => actionFromToolCall(c.name, (c.args ?? {}) as Record<string, unknown>, c.id ?? `${c.name}:${i}`))
      .filter((a): a is Action => a !== null);
    if (proposed.length === 0) {
      return { messages: answerToolCalls(allCalls, "Não entendi qual ação você quer. Pode repetir?") };
    }

    const wctx = await loadWriteContext(deps, ctx.orgId, ctx.agentId, proposed.map((a) => a.target));
    if (!wctx) {
      return { messages: answerToolCalls(allCalls, "Não consegui acessar a conta agora. Tenta de novo em instantes.") };
    }

    // guardrail no LOTE inteiro (uma chamada) — senão o cap de entidades/dia não acumula
    // entre as ações do mesmo turno (seenEntities é por-chamada). §8: guardrail sempre.
    const check = applyGuardrails(proposed, wctx.cfg, wctx.ctx);
    const labelOf = (a: Action) => a.target.name ?? a.target.id;
    const blocked = check.dropped.map((d) => `${labelOf(d.action)}: ${d.reason}`);

    const echoItems: EchoItem[] = [];
    const frozen: Action[] = [];
    for (const clamped of check.allowed) {
      try {
        const dry = await deps.ports.ads.mutate(wctx.account, clamped, { dryRun: true });
        echoItems.push({
          action: clamped,
          before: dry.before as Record<string, unknown>,
          after: dry.after as Record<string, unknown>,
          entityName: clamped.target.name ?? clamped.target.id,
          currency: wctx.currency,
          // nomeia a conta no eco só em org multi-conta (evita ruído em org de 1 conta).
          ...(ctx.multiAccount && ctx.accountName ? { accountName: ctx.accountName } : {}),
        });
        frozen.push(clamped);
      } catch (err) {
        logger.warn({ err, entityId: clamped.target.id }, "conversation:dry-run do eco falhou");
        blocked.push(`${labelOf(clamped)}: não consegui simular agora`);
      }
    }

    const parts: string[] = [];
    // shadow (dry_run): o eco avisa que vai SIMULAR — senão "vou pausar" soa como escrita real.
    if (wctx.cfg.dryRun && echoItems.length > 0) parts.push("🧪 Modo simulação (não aplico de verdade):");
    if (echoItems.length > 0) parts.push(buildWriteEcho(echoItems));
    if (blocked.length > 0) parts.push(`Não consigo:\n${blocked.map((b, i) => `${i + 1}. ${b}`).join("\n")}`);
    const echo = parts.join("\n\n") || "Não consegui preparar essa ação.";

    const update: WhatsappConversationUpdate = {
      messages: [...answerToolCalls(allCalls, "proposto — aguardando confirmação"), new AIMessage(echo)],
      pendingRevert: null,
    };
    if (frozen.length > 0) {
      update.pendingWrite = {
        echo,
        expiresAt: new Date(Date.now() + PENDING_WRITE_TTL_MS).toISOString(),
        actions: frozen,
      };
    }
    return update;
  }

  /** Turno 2: aplica (confirm_write) ou descarta (cancel_write) a pendência congelada. */
  async function applyWrite(state: WhatsappConversationStateType): Promise<WhatsappConversationUpdate> {
    const last = state.messages.at(-1) as AIMessage | undefined;
    const calls = last?.tool_calls ?? [];
    const isConfirm = calls.some((c) => c.name === "confirm_write");

    if (!isConfirm) {
      return {
        messages: [...answerToolCalls(calls, "cancelado"), new AIMessage("Ok, não mexi em nada.")],
        pendingWrite: null,
        pendingRevert: null,
        pendingConfigChange: null,
        pendingDraft: null,
      };
    }

    // RASCUNHO confirmado (Fatia 7): enfileira a saga de criação (mesmo apply-service do
    // site) — o worker re-checa o guardrail de gasto novo, cria e empurra o desfecho.
    const pendingDraft = activePendingDraft(state.pendingDraft);
    if (pendingDraft) {
      await deps.ports.scheduler.enqueue({
        queue: APPROVAL_APPLY_QUEUE,
        name: APPROVAL_APPLY_JOB,
        payload: { orgId: ctx.orgId, approvalId: pendingDraft.approvalId, notifyRef: ctx.ref },
      });
      return {
        messages: [...answerToolCalls(calls, "criando"), new AIMessage("Beleza, tô criando — te aviso quando ficar pronto. 🚀")],
        pendingDraft: null,
        pendingWrite: null,
        pendingRevert: null,
      };
    }

    // CONFIG confirmada (S2.3–S2.6): aplica o CONGELADO (o "sim" não re-especifica nada).
    // Ordem dos ramos: revert → config → write (mutuamente exclusivos por nome de tool).
    const pendingConfig = activePendingConfig(state.pendingConfigChange);
    if (pendingConfig) {
      const reply = await applyConfirmedConfig(deps, ctx, pendingConfig);
      return {
        messages: [...answerToolCalls(calls, "config"), new AIMessage(reply)],
        pendingConfigChange: null,
        pendingWrite: null,
        pendingRevert: null,
      };
    }

    // DESFAZER confirmado (5c-4): reverte cada ação por id (drift + TTL já no executor).
    const pendingRevert = activePendingRevert(state.pendingRevert);
    if (pendingRevert) {
      const lines: string[] = [];
      for (const toolCallId of pendingRevert.toolCallIds) {
        const res = await revertActionById(deps, { orgId: ctx.orgId, toolCallId });
        lines.push(
          res.reverted
            ? "✅ Desfeito."
            : res.blockedByDrift
              ? `Não desfiz: ${res.reason ?? "a entidade mudou desde a ação"}. Se quiser desfazer mesmo assim, me avise.`
              : `Não consegui desfazer: ${res.reason ?? "ação não encontrada"}.`,
        );
      }
      return { messages: [...answerToolCalls(calls, "revert"), new AIMessage(lines.join("\n"))], pendingRevert: null, pendingWrite: null };
    }

    const pending = activePendingWrite(state.pendingWrite);
    if (!pending) {
      return {
        messages: [...answerToolCalls(calls, "nada pendente"), new AIMessage("Não tenho nada pendente pra confirmar (ou já expirou). Me diz de novo o que você quer.")],
        pendingWrite: null,
      };
    }

    const wctx = await loadWriteContext(deps, ctx.orgId, ctx.agentId, pending.actions.map((a) => a.target));
    if (!wctx) {
      return {
        messages: [...answerToolCalls(calls, "conta indisponível"), new AIMessage("Não consegui acessar a conta agora. Tenta de novo em instantes.")],
        pendingWrite: null,
      };
    }

    // escrita por chat: sem run de análise (runId null); o agentId é a âncora da trilha.
    // Acumula as entidades já aplicadas em touchedToday a cada iteração — senão o cap de
    // entidades/dia não vale DENTRO do lote (applyGuardrails é por-ação aqui). §8.
    const touchedToday = new Set<string>(wctx.ctx.touchedToday ?? []);
    const lines: string[] = [];
    for (const action of pending.actions) {
      const outcome = await applyCheckedAction({
        executor,
        account: wctx.account,
        action,
        cfg: wctx.cfg,
        ctx: { ...wctx.ctx, touchedToday },
        agentId: ctx.agentId,
        runId: null,
        orgId: ctx.orgId,
        idempotencyKey: `conv:${ctx.conversationId}:${action.id}`,
      });
      if (outcome.kind === "applied") touchedToday.add(entityKeyOf(action.target));
      lines.push(outcomeLine(action, outcome));
    }
    return { messages: [...answerToolCalls(calls, "aplicado"), new AIMessage(lines.join("\n"))], pendingWrite: null };
  }

  return { agent, toolsNode, confirmWriteGate, applyWrite };
}

/**
 * Roteamento ReAct pós-agent: controle do eco (confirm_write/cancel_write) → "apply";
 * tool de ESCRITA livre → "confirm" (eco+confirma); tool de LEITURA → "tools"; sem tool
 * call → END (responde ao usuário).
 */
export function routeConversation(
  state: WhatsappConversationStateType,
): "tools" | "confirm" | "apply" | "__end__" {
  const last = state.messages.at(-1);
  const toolCalls = (last as AIMessage | undefined)?.tool_calls ?? [];
  if (toolCalls.length === 0) return "__end__";
  if (toolCalls.some((c) => CONTROL_WRITE_TOOL_NAMES.has(c.name))) return "apply";
  // escrita Meta livre, reversão, mudança de config OU describe (emitido verbatim) → nó "confirm".
  if (
    toolCalls.some(
      (c) =>
        WRITE_TOOL_NAMES.has(c.name) ||
        CREATE_TOOL_NAMES.has(c.name) ||
        REFINE_TOOL_NAMES.has(c.name) ||
        c.name === REVERT_TOOL_NAME ||
        c.name === DESCRIBE_CAPABILITIES_TOOL_NAME ||
        isConfirmableConfigTool(c.name),
    )
  )
    return "confirm";
  return "tools";
}
