// Nós do grafo `whatsapp-conversation` (ReAct): agent (LLM+tools) ↔ tools, com um
// gate de confirmação humana antes de qualquer ESCRITA (5b-2.3). Na 5b-2.2 só há
// tools de LEITURA + trigger_analysis, então o gate fica inativo (nenhuma write tool).

import { ChatOpenAI } from "@langchain/openai";
import { AIMessage, SystemMessage } from "@langchain/core/messages";
import { ToolNode } from "@langchain/langgraph/prebuilt";
import type { Logger } from "pino";
import { sleep } from "@trafego/shared";
import type { OrgId } from "@trafego/shared/types";
import type { WorkerDeps } from "../../composition.js";
import { loadConversationConfig } from "./system-prompt.js";
import { windowMessages } from "./window.js";
import {
  WRITE_TOOL_NAMES,
  makeConversationTools,
  type ConversationToolContext,
} from "./tools.js";
import type {
  WhatsappConversationStateType,
  WhatsappConversationUpdate,
} from "./state.js";

const CONVERSATION_TEMPERATURE = 0.3;

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

  /** Nó ReAct: LLM (OpenRouter) com as tools da allowlist + voz do agente. */
  async function agent(state: WhatsappConversationStateType): Promise<WhatsappConversationUpdate> {
    logger.debug({ contactId: ctx.contactId }, "conversation:agent");
    const { systemPrompt, model } = await loadConversationConfig(
      deps.db,
      ctx.orgId,
      ctx.agentId.length > 0 ? ctx.agentId : null,
      deps.conversation.model,
    );

    const chat = new ChatOpenAI({
      model,
      apiKey: deps.conversation.apiKey,
      configuration: { baseURL: deps.conversation.baseUrl },
      temperature: CONVERSATION_TEMPERATURE,
      // OpenRouter devolve custo real quando pedimos usage — essencial p/ o billing (§11).
      // Com .bindTools() abaixo, o @langchain/openai suprime response_metadata.usage
      // (custo some) mesmo assim — patchCostInBackground() cobre com fallback
      // assíncrono por generation id (nunca bloqueia esta resposta).
      modelKwargs: { usage: { include: true } },
    }).bindTools(tools);

    // janela por turno + teto de tokens (nunca quebra par tool_call/tool_result).
    const windowed = windowMessages(state.messages, {
      maxTurns: deps.conversation.historyTurns,
      maxTokens: deps.conversation.maxTokens,
    });
    const response = (await chat.invoke([new SystemMessage(systemPrompt), ...windowed])) as AIMessage;

    // metering (§11): as chamadas do chat também entram no ledger de custo.
    await recordConversationUsage(deps, ctx, model, response);

    return { messages: [response] };
  }

  /** Executa as tools de leitura escolhidas pelo modelo (escrita passa pelo gate). */
  function toolsNode() {
    return new ToolNode(tools);
  }

  /**
   * Gate de confirmação antes de QUALQUER escrita (CLAUDE §8). Inativo na 5b-2.2
   * (sem write tools); implementado na 5b-2.3 (aprovação conversacional).
   */
  async function confirmWriteGate(): Promise<WhatsappConversationUpdate> {
    return {};
  }

  return { agent, toolsNode, confirmWriteGate };
}

/**
 * Roteamento ReAct pós-agent: tool de LEITURA → "tools"; tool de ESCRITA →
 * "confirm" (5b-2.3); sem tool call → END (responde ao usuário).
 */
export function routeConversation(
  state: WhatsappConversationStateType,
): "tools" | "confirm" | "__end__" {
  const last = state.messages.at(-1);
  const toolCalls = (last as AIMessage | undefined)?.tool_calls ?? [];
  if (toolCalls.length === 0) return "__end__";
  const hasWrite = toolCalls.some((c) => WRITE_TOOL_NAMES.has(c.name));
  return hasWrite ? "confirm" : "tools";
}
