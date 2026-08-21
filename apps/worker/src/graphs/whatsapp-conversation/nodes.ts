// Nós do grafo `whatsapp-conversation` (ReAct): agent (LLM+tools) ↔ tools, com um
// gate de confirmação humana antes de qualquer ESCRITA (5b-2.3). Na 5b-2.2 só há
// tools de LEITURA + trigger_analysis, então o gate fica inativo (nenhuma write tool).

import { ChatOpenAI } from "@langchain/openai";
import { AIMessage, HumanMessage, SystemMessage, ToolMessage, type BaseMessage } from "@langchain/core/messages";
import { ToolNode } from "@langchain/langgraph/prebuilt";
import type { Logger } from "pino";
import { applyGuardrails, buildRevertEcho, buildWriteEcho, entityKeyOf, type EchoItem, type RevertEchoItem } from "@trafego/core";
import { sleep } from "@trafego/shared";
import type { Action, OrgId } from "@trafego/shared/types";
import type { WorkerDeps } from "../../composition.js";
import { loadConversationConfig } from "./system-prompt.js";
import { windowMessages } from "./window.js";
import {
  CONTROL_WRITE_TOOL_NAMES,
  REVERT_TOOL_NAME,
  WRITE_TOOL_NAMES,
  actionFromToolCall,
  makeConversationTools,
  type ConversationToolContext,
} from "./tools.js";
import { makeMetaToolExecutor } from "../../executors/meta-tools.js";
import { applyCheckedAction, type ApplyOutcome } from "../../modules/apply/apply-confirmed-action.js";
import { loadWriteContext } from "../../modules/apply/write-context.js";
import { revertActionById } from "../../modules/apply/revert-action.js";
import type {
  PendingRevert,
  PendingWrite,
  WhatsappConversationStateType,
  WhatsappConversationUpdate,
} from "./state.js";

const CONVERSATION_TEMPERATURE = 0.3;

/** TTL do eco+confirma: um "sim" muito depois não aplica uma ação esquecida (§8). */
const PENDING_WRITE_TTL_MS = 30 * 60 * 1000;

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
      type: "conversation",
      provider: "openrouter",
      model,
      ...usage,
      payload: { contactId: ctx.contactId },
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

export function makeConversationNodes(
  deps: WorkerDeps,
  ctx: ConversationToolContext,
  allow: ReadonlySet<string>,
) {
  const { logger } = deps;
  const tools = makeConversationTools(deps, ctx, allow);

  const executor = makeMetaToolExecutor(deps);

  /** Nova instância de chat LLM (OpenRouter). `withTools` liga as tools da allowlist. */
  function makeChat(model: string, withTools: boolean) {
    const chat = new ChatOpenAI({
      model,
      apiKey: deps.conversation.apiKey,
      configuration: { baseURL: deps.conversation.baseUrl },
      temperature: CONVERSATION_TEMPERATURE,
      // OpenRouter devolve custo real quando pedimos usage — essencial p/ o billing (§11).
      // Com .bindTools(), o @langchain/openai suprime response_metadata.usage (custo some)
      // — patchCostInBackground() cobre com fallback assíncrono (nunca bloqueia a resposta).
      modelKwargs: { usage: { include: true } },
    });
    return withTools ? chat.bindTools(tools) : chat;
  }

  /** Nó ReAct: LLM (OpenRouter) com as tools da allowlist + voz do agente. */
  async function agent(state: WhatsappConversationStateType): Promise<WhatsappConversationUpdate> {
    logger.debug({ contactId: ctx.contactId }, "conversation:agent");
    const { systemPrompt, model } = await loadConversationConfig(
      deps.db,
      ctx.orgId,
      ctx.agentId.length > 0 ? ctx.agentId : null,
      deps.conversation.model,
    );

    // eco+confirma (5c): se há ação/reversão pendente válida, oriente o LLM a só
    // CLASSIFICAR a intenção (confirm_write/cancel_write) — o que se aplica é o congelado.
    const pending = activePendingWrite(state.pendingWrite);
    const pendingRevert = activePendingRevert(state.pendingRevert);
    const echo = pending?.echo ?? pendingRevert?.echo;
    const sys = echo
      ? `${systemPrompt}\n\nHá algo que você já propôs e que aguarda a confirmação do usuário:\n${echo}\n\nSe a última mensagem do usuário confirmar claramente (ex: "sim", "pode", "manda"), chame confirm_write. Se recusar, chame cancel_write. Se pedir mudança/outra coisa, IGNORE a pendência e trate normalmente.`
      : systemPrompt;

    const windowed = windowMessages(state.messages, {
      maxTurns: deps.conversation.historyTurns,
      maxTokens: deps.conversation.maxTokens,
    });
    const response = (await makeChat(model, true).invoke([new SystemMessage(sys), ...windowed])) as AIMessage;
    await recordConversationUsage(deps, ctx, model, response);

    // limpa pendências expiradas (o "sim" tardio não aplica algo esquecido).
    const update: WhatsappConversationUpdate = { messages: [response] };
    if (state.pendingWrite && !pending) update.pendingWrite = null;
    if (state.pendingRevert && !pendingRevert) update.pendingRevert = null;
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
  if (toolCalls.some((c) => WRITE_TOOL_NAMES.has(c.name) || c.name === REVERT_TOOL_NAME)) return "confirm";
  return "tools";
}
