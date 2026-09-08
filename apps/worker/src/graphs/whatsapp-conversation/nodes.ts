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
  checkPhoneAttribution,
  collectGroundedNumbers,
  CREATIVE_CRITIQUE_KNOWLEDGE,
  describeActionOutcome,
  describePlaybookRule,
  entityKeyOf,
  flagUngroundedNumbers,
  resolveAgentConfigChange,
  riskForAction,
  type EchoItem,
  type GuardrailContext,
  type RevertEchoItem,
  type UngroundedNumber,
} from "@trafego/core";
import { applyAgentConfigChange, loadAgentConfigState, reseedArchetypeChange } from "@trafego/agent-config";
import { sleep, phoneTokensInText, buildApprovalApplyJob, ACTION_PARAM_TARGETING, ACTION_PARAM_MODE, ACTION_PARAM_AMOUNT_MINOR, BUDGET_MODE_SET, formatMoneyMinor, toMinorUnits } from "@trafego/shared";
import type { Action, ApprovalId, ConversionGoal, OrgId } from "@trafego/shared/types";
import { CONVERSION_GOALS } from "@trafego/shared/types";
import { AdsPlatformError } from "@trafego/shared/ports";
import { MIN_BUDGET_MINOR } from "@trafego/ads-meta";
import { and, eq } from "drizzle-orm";
import { adAccounts, agents, playbookRules, type Database } from "@trafego/db";
import { DEFAULT_CURRENCY } from "@trafego/shared";
import type { WorkerDeps } from "../../composition.js";
import { describeLlmError } from "./llm-error.js";
import { capWarningNote, expandChainActivation } from "../../modules/apply/chain-activation.js";
import { GROUP_RULES, loadConversationConfig } from "./system-prompt.js";
import { sanitizeToolPairs, stripHistoricalImages, windowMessages } from "./window.js";
import {
  CONFIG_UPDATE_TOOL_NAMES,
  CONTROL_WRITE_TOOL_NAMES,
  CREATE_TOOL_NAMES,
  EDIT_AUDIENCE_TOOL_NAME,
  REALLOCATE_TOOL_NAME,
  REFINE_TOOL_NAMES,
  PLAYBOOK_WRITE_TOOL_NAMES,
  REVERT_TOOL_NAME,
  DESCRIBE_CAPABILITIES_TOOL_NAME,
  WHATSAPP_NUMBER_TOOL_NAME,
  RESEED_TOOL_NAME,
  WRITE_TOOL_NAMES,
  actionFromToolCall,
  resolveBudgetMinor,
  buildCapabilitiesText,
  isConfirmableConfigTool,
  makeConversationTools,
  mergeConfigUpdatePatches,
  pendingRuleToDescriptor,
  playbookOpFromToolCall,
  ruleRowToDescriptor,
  type ConversationToolContext,
} from "./tools.js";
import { latestAnalysisAsOf, renderWhatsappNumber, resolveWhatsappNumber } from "./read-data.js";
import { makeMetaToolExecutor } from "../../executors/meta-tools.js";
import { applyCheckedAction, type ApplyResult } from "../../modules/apply/apply-confirmed-action.js";
import { runReallocationSaga } from "../../modules/apply/reallocation-saga.js";
import { buildRefineEcho, describeExplicitAudience, MEDIA_PREFERENCES, proposeCopyCampaign, proposeCreateCampaign, proposeScaleWinner, recoverOpenDraft, refineDraft, resolveProposedExplicitTargeting, type DraftProposalContext, type MediaPreference, type ProposedExplicitInput, type RecoveredDraft } from "../../modules/conversation/draft-proposal.js";
import { loadWriteContext, reallocKindPeriod, type BudgetPeriodKind } from "../../modules/apply/write-context.js";
import { adHasNoBudgetMessage, resolveMisplacedBudgetMessage } from "./budget-location.js";
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

/** B3: seção injetada quando o usuário mandou um criativo perguntando (imagem anexada ao turno).
 *  O modelo JÁ vê a imagem (conteúdo multimodal); isto aterra a leitura no método do squad e pede
 *  resposta natural (não um formulário). Só entra quando há mídia — não infla o prompt normal. */
const MEDIA_QUESTION_SECTION = [
  "O usuário te mandou um criativo (imagem) junto da mensagem — você está VENDO essa imagem agora.",
  "Responda à pergunta dele sobre a imagem de forma direta e natural, como um gestor falando.",
  "Se for uma crítica/avaliação de criativo, use o método abaixo (gancho, ângulo, prova, fadiga) —",
  "sem soletrar um formulário; teça no texto. Se a imagem não for um criativo (ex: um print), responda",
  "ao que ele perguntou sem forçar decomposição.",
  "",
  "IMPORTANTE — guardar: toda imagem que ele te manda JÁ É GUARDADA automaticamente na biblioteca de",
  "criativos da conta em contexto (o upload roda em segundo plano; ela fica disponível pra usar num",
  "rascunho de campanha depois). Então isso NÃO é algo que você 'não consegue fazer': se ele pedir pra",
  "guardar ('guarda aí'), confirme com naturalidade que já está indo pra biblioteca — NUNCA diga que",
  "não consegue salvar na biblioteca (é falso). Só peça a conta se você AINDA não sabe de qual conta é",
  "(nenhuma conta em contexto). Se a imagem tiver marca d'água/logo de banco de imagens, aí sim vale",
  "avisar que é bom trocar por uma versão limpa antes de anunciar.",
  "",
  CREATIVE_CRITIQUE_KNOWLEDGE,
].join("\n");

/** Guard: `v` é um ConversionGoal da taxonomia neutra (o LLM manda goal como texto livre). */
function isConversionGoal(v: unknown): v is ConversionGoal {
  return typeof v === "string" && (CONVERSION_GOALS as readonly string[]).includes(v);
}

/** Guard: `v` é uma preferência de mídia válida (video/image/mixed). */
function isMediaPreference(v: unknown): v is MediaPreference {
  return typeof v === "string" && (MEDIA_PREFERENCES as readonly string[]).includes(v);
}

/** Normaliza os copyEdits vindos do LLM (índice + campos de texto), filtrando entradas inválidas. */
function parseCopyEdits(v: unknown): { index: number; headline?: string; primaryText?: string; description?: string; adName?: string }[] {
  if (!Array.isArray(v)) return [];
  const out: { index: number; headline?: string; primaryText?: string; description?: string; adName?: string }[] = [];
  for (const e of v) {
    if (!e || !Number.isInteger((e as { index?: unknown }).index)) continue;
    const o = e as Record<string, unknown>;
    out.push({
      index: o["index"] as number,
      ...(typeof o["headline"] === "string" && o["headline"] ? { headline: o["headline"] } : {}),
      ...(typeof o["primaryText"] === "string" && o["primaryText"] ? { primaryText: o["primaryText"] } : {}),
      ...(typeof o["description"] === "string" ? { description: o["description"] } : {}),
      ...(typeof o["adName"] === "string" && o["adName"] ? { adName: o["adName"] } : {}),
    });
  }
  return out;
}

/** Normaliza os setAdCreative vindos do LLM (índice + nome do criativo), filtrando entradas inválidas. */
function parseSetAdCreative(v: unknown): { index: number; creative: string }[] {
  if (!Array.isArray(v)) return [];
  const out: { index: number; creative: string }[] = [];
  for (const e of v) {
    if (!e || !Number.isInteger((e as { index?: unknown }).index)) continue;
    const o = e as Record<string, unknown>;
    if (typeof o["creative"] !== "string" || !o["creative"].trim()) continue;
    out.push({ index: o["index"] as number, creative: o["creative"].trim() });
  }
  return out;
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
/**
 * Data/hora atual no FUSO DA ORG — o LLM precisa do "agora" pra raciocínio temporal
 * (checkpoints, "até 12h", "há X horas", hoje/ontem). Sem isto o modelo não sabe a data.
 */
export function currentDateTimeLine(tz: string, now: Date = new Date()): string {
  const fmt = new Intl.DateTimeFormat("pt-BR", { timeZone: tz, dateStyle: "full", timeStyle: "short" }).format(now);
  return `Agora (fuso ${tz}): ${fmt}. Este é o momento presente — use-o SEMPRE para raciocínio de tempo (checkpoints, "até 12h", "há X horas", hoje/ontem). Nunca diga que não sabe a data/hora.`;
}

/**
 * Frescor do dado curado: QUANDO a última análise concluída rodou (fuso da org). Sem esta linha o
 * LLM não sabe de quando são os números que ele tem em mãos — inclusive os que ele mesmo acabou de
 * empurrar no push de "análise concluída" — e, perguntado "isto é de hoje?", DEFLETE ("vieram de
 * uma análise anterior… preciso atualizar") em vez de dar a data. Com o `asOf` à vista, ele compara
 * com o "agora" e responde o óbvio (o push acabou de rodar → "sim, é de hoje"). `asOf` null (nenhuma
 * análise ainda) → linha some. PURA.
 */
export function lastAnalysisLine(asOf: Date | null, tz: string): string {
  if (!asOf) return "";
  const fmt = new Intl.DateTimeFormat("pt-BR", { timeZone: tz, dateStyle: "full", timeStyle: "short" }).format(asOf);
  return `Última análise concluída desta conta: ${fmt} (fuso ${tz}). Todo número curado que você tem — a nota, o gasto, as recomendações e o resumo/push que você já enviou — é DESSA análise (não é ao vivo). Se te perguntarem se um dado é "de hoje"/atual/"de quando é", responda com ESSA data comparando com o agora (ex: se acabou de rodar, "sim, é de agora"); NUNCA diga que não sabe a data nem que "veio de uma análise anterior" sem dizer qual. Só se precisar do estado ATUAL ao vivo (não o desta análise) use get_fresh_metrics ou rode uma análise nova (trigger_analysis).`;
}

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

/** Achados da detecção SOFT de honestidade (só reportados, sem eco ao usuário). */
interface UngroundedFinalAnswer {
  readonly money: readonly UngroundedNumber[];
  readonly phones: readonly string[];
}

/**
 * Detecção SOFT de honestidade (Fatia 7): identifica na resposta final DINHEIRO/% ausente
 * das fontes (tools + config no system-prompt + histórico) ou um TELEFONE que não veio de tool
 * (misatribuição). NÃO altera o texto e NÃO anexa mais o caveat visível — por decisão de produto
 * o aviso ao usuário foi removido; a detecção segue rodando só para observabilidade (log). Pura.
 */
function detectUngroundedFinalAnswer(text: string, systemPrompt: string, windowed: readonly BaseMessage[]): UngroundedFinalAnswer {
  const toolResults: string[] = [];
  const history: string[] = [];
  for (const m of windowed) {
    const c = typeof m.content === "string" ? m.content : "";
    if (!c) continue;
    if (m instanceof ToolMessage) toolResults.push(c);
    else history.push(c);
  }
  const known = collectGroundedNumbers({ toolResults, configText: [systemPrompt], history });
  // telefone ancorado = veio de tool NESTE turno OU já apareceu antes no fio (render verbatim /
  // o próprio usuário) — repetir um número já dito no thread não é misatribuição.
  const allowedPhones = new Set([...toolResults, ...history].flatMap((t) => phoneTokensInText(t)));
  return {
    money: flagUngroundedNumbers(text, known),
    phones: checkPhoneAttribution(text, allowedPhones),
  };
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

/** RecoveredDraft (banco) → PendingDraft (estado): eco fresco do spec + TTL renovado. */
function recoveredToPending(rec: RecoveredDraft): PendingDraft {
  return {
    draftId: rec.draftId,
    approvalId: rec.approvalId,
    echo: buildRefineEcho(rec.kind, rec.spec),
    expiresAt: new Date(Date.now() + PENDING_WRITE_TTL_MS).toISOString(),
  };
}

/** Recupera o rascunho aberto do banco como PendingDraft (estado), ou null. */
async function recoverOrNull(deps: WorkerDeps, dctx: DraftProposalContext): Promise<PendingDraft | null> {
  const rec = await recoverOpenDraft(deps, dctx);
  return rec ? recoveredToPending(rec) : null;
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

/** Linha de desfecho de UMA ação aplicada (voz determinística, §UX). Mapeia o `ApplyResult`
 *  runtime pro `OutcomeDetail` e reusa `describeActionOutcome` — MESMA copy/voz do card do site e
 *  do push do approval-apply (fonte única, §13 reuso-primeiro). */
function outcomeLine(action: Action, outcome: ApplyResult): string {
  switch (outcome.kind) {
    case "applied":
      return describeActionOutcome(action, { kind: outcome.dryRun ? "simulated" : "applied" });
    case "noop":
      return describeActionOutcome(action, { kind: "noop" });
    case "blocked":
      return describeActionOutcome(action, { kind: "blocked", reason: outcome.reason });
    case "failed": {
      const metaMessage =
        outcome.error instanceof AdsPlatformError && outcome.error.userMessage ? `A Meta informou: ${outcome.error.userMessage.trim()}` : undefined;
      return describeActionOutcome(action, { kind: "failed", ...(metaMessage !== undefined ? { metaMessage } : {}) });
    }
  }
}

/** Motivo curto de um desfecho que NÃO aplicou (blocked/failed) — p/ a mensagem da saga (A4). */
function reallocFailReason(outcome: ApplyResult): string {
  if (outcome.kind === "blocked") return outcome.reason;
  if (outcome.kind === "failed" && outcome.error instanceof AdsPlatformError && outcome.error.userMessage) {
    return outcome.error.userMessage.trim();
  }
  return "não consegui aplicar agora";
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
      ctx.chatAdsWrites ?? false,
    );

    // eco+confirma (5c): se há ação/reversão pendente válida, oriente o LLM a só
    // CLASSIFICAR a intenção (confirm_write/cancel_write) — o que se aplica é o congelado.
    const pending = activePendingWrite(state.pendingWrite);
    const pendingRevert = activePendingRevert(state.pendingRevert);
    const pendingConfig = activePendingConfig(state.pendingConfigChange);
    const echo = pending?.echo ?? pendingRevert?.echo ?? pendingConfig?.echo;

    // seção de grupo (regras + contexto ambiente; group-only, efêmera, entre a voz e o eco). DM → "".
    // data/hora atual (fuso da org) na FRENTE — sem isso o LLM não tem "agora" p/ raciocínio
    // temporal (checkpoints, "até 12h", "há X horas", hoje/ontem) e responde que não sabe a hora.
    // Junto: QUANDO a última análise concluída rodou (asOf do dado curado) — sem isso o LLM não sabe
    // de quando são os números que ele tem (nem os que empurrou no push de análise) e deflete no
    // "isto é de hoje?". Só com conta em foco (agentId); concierge sem foco → linha some.
    const asOf = ctx.agentId.length > 0 ? await latestAnalysisAsOf(deps.db, ctx.agentId, ctx.orgId) : null;
    const freshness = [currentDateTimeLine(ctx.timezone), lastAnalysisLine(asOf, ctx.timezone)]
      .filter((l) => l.length > 0)
      .join("\n\n");
    // B3: mídia anexada → injeta o kernel de criativo (aterra a leitura); só quando há imagem.
    const baseSys = `${freshness}\n\n${systemPrompt}${ctx.attachedMedia ? `\n\n${MEDIA_QUESTION_SECTION}` : ""}`;
    const sys = assembleSystemPrompt(baseSys, await groupSection(), echo);

    const windowed = windowMessages(state.messages, {
      maxTurns: deps.conversation.historyTurns,
      maxTokens: deps.conversation.maxTokens,
    });
    // Sanitiza pares tool_call/result: um turno anterior que QUEBROU entre o AI(tool_calls) e as
    // respostas das tools deixa um órfão no checkpoint → a API rejeita (400 "No tool output found")
    // e o thread fica envenenado (todo turno reenvia o órfão). Remover o órfão CURA o thread.
    const msgs = [new SystemMessage(sys), ...stripHistoricalImages(sanitizeToolPairs(windowed))];
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

    // DETECÇÃO SOFT de honestidade (Fatia 7): só na resposta FINAL (sem tool call — o que vai
    // ao usuário). O caveat visível foi removido por decisão de produto; a detecção segue só
    // para observabilidade (log) — nunca altera o texto. Answer-key = system-prompt (config:
    // guidance/metas/guardrails) + resultados de tool + histórico do turno. Telefone tem
    // checagem estrutural própria (a raiz do bug foi misatribuição cross-entity). Sem número
    // de telefone no log (PII/LGPD): só a contagem.
    if ((response.tool_calls?.length ?? 0) === 0 && typeof response.content === "string") {
      const flagged = detectUngroundedFinalAnswer(response.content, sys, windowed);
      if (flagged.money.length > 0 || flagged.phones.length > 0) {
        logger.warn(
          { actor: actorLabel(ctx.ref), money: flagged.money.map((m) => m.raw), phoneCount: flagged.phones.length },
          "conversation:resposta com valores não ancorados (caveat suprimido por config)",
        );
      }
    }

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
    // rótulo "(conta)" no eco — só em org multi-conta (evita ruído em org de 1 conta). Fonte única
    // da decisão E do texto: `showAccount` gateia, `acctLbl` é o texto derivado.
    const showAccount = Boolean(ctx.multiAccount && ctx.accountName);
    const acctLbl = showAccount ? ` (${ctx.accountName})` : "";

    // DESCRIBE_CAPABILITIES: emite o texto HONESTO VERBATIM (o LLM parafraseava e dropava
    // linhas de limitação, ex: "config é pelo site"). É informativo puro — não coexiste com escrita.
    const describeCall = allCalls.find((c) => c.name === DESCRIBE_CAPABILITIES_TOOL_NAME);
    if (describeCall) {
      const text = await buildCapabilitiesText(deps, ctx, allow);
      return { messages: [...answerToolCalls(allCalls, "capabilities"), new AIMessage(text)] };
    }

    // GET_WHATSAPP_NUMBER (Fatia 7): resolve escopado ao campaignId (DB-first + live) e
    // RENDERIZA VERBATIM — o LLM não digita os dígitos, então não pode misatribuir o número
    // de outra campanha (a raiz do bug reportado). Informativo puro — não coexiste com escrita.
    const waCall = allCalls.find((c) => c.name === WHATSAPP_NUMBER_TOOL_NAME);
    if (waCall) {
      const a = (waCall.args ?? {}) as Record<string, unknown>;
      const campaignId = typeof a["campaignId"] === "string" ? a["campaignId"].trim() : "";
      // sem CONTA em foco (ex: grupo com foco expirado) → pede a conta antes de tentar resolver
      // (resolver com adAccountId vazio derrubava o turno no loadAccount — uuid inválido).
      if (!ctx.adAccountId) {
        return {
          messages: [...answerToolCalls(allCalls, "sem conta"), new AIMessage("Primeiro me diz de qual conta é essa campanha (ex: \"foca na Loja X\") que aí eu busco o número de WhatsApp certo.")],
        };
      }
      if (!campaignId) {
        return {
          messages: [...answerToolCalls(allCalls, "sem id"), new AIMessage("Me diz qual campanha (o nome que eu identifico) que eu descubro o número de WhatsApp de destino dela.")],
        };
      }
      const dest = await resolveWhatsappNumber(deps, ctx, campaignId);
      const label = typeof a["campaignName"] === "string" && a["campaignName"] ? (a["campaignName"] as string) : (dest.entityName ?? campaignId);
      return { messages: [...answerToolCalls(allCalls, "whatsapp"), new AIMessage(renderWhatsappNumber(dest, label))] };
    }

    // REFINAMENTO conversacional (Fatia 7): ajusta/regenera o rascunho PENDENTE sem criar
    // outro — muta o campaign_drafts + re-ecoa; o "sim" segue aplicando o MESMO rascunho.
    const refineCall = allCalls.find((c) => REFINE_TOOL_NAMES.has(c.name));
    if (refineCall) {
      const dctxRefine = { orgId: ctx.orgId, agentId: ctx.agentId, adAccountId: ctx.adAccountId, currency: DEFAULT_CURRENCY };
      // estado efêmero expirou (TTL 30min)? o rascunho pode seguir ABERTO no banco (fonte da verdade)
      // → recupera em vez de dar dead-end (o incidente do grupo: "5 criativos diferentes" 91min depois).
      let active = activePendingDraft(state.pendingDraft) ?? (await recoverOrNull(deps, dctxRefine));
      if (!active) {
        return {
          messages: [
            ...answerToolCalls(allCalls, "sem rascunho"),
            new AIMessage("Não tenho um rascunho de campanha aberto pra ajustar agora. Quer que eu monte um? É só dizer o que criar ou escalar (ex: \"cria uma campanha de leads\")."),
          ],
        };
      }
      const a = (refineCall.args ?? {}) as Record<string, unknown>;
      const patch =
        refineCall.name === "regenerate_copy"
          ? { regenerateCopy: true }
          : {
              ...(typeof a["budgetReais"] === "number" ? { budgetReais: a["budgetReais"] as number } : {}),
              ...(a["activation"] === "active" || a["activation"] === "paused" ? { activation: a["activation"] as "active" | "paused" } : {}),
              ...(typeof a["variantsCount"] === "number" ? { variantsCount: a["variantsCount"] as number } : {}),
              ...(a["audience"] === "reuse" || a["audience"] === "broad" ? { audience: a["audience"] as "reuse" | "broad" } : {}),
              ...(typeof a["link"] === "string" && a["link"].trim().length > 0 ? { link: a["link"].trim() } : {}),
              ...(isConversionGoal(a["objective"]) ? { objective: a["objective"] } : {}),
              ...(typeof a["campaignName"] === "string" && a["campaignName"] ? { campaignName: a["campaignName"] as string } : {}),
              ...(typeof a["adsetName"] === "string" && a["adsetName"] ? { adsetName: a["adsetName"] as string } : {}),
              ...(Array.isArray(a["removeGeo"]) ? { removeGeo: a["removeGeo"].filter((x): x is string => typeof x === "string") } : {}),
              ...(Array.isArray(a["addGeo"]) ? { addGeo: a["addGeo"].filter((x): x is string => typeof x === "string") } : {}),
              ...(typeof a["ageMin"] === "number" ? { ageMin: a["ageMin"] as number } : {}),
              ...(typeof a["ageMax"] === "number" ? { ageMax: a["ageMax"] as number } : {}),
              ...(a["gender"] === "men" || a["gender"] === "women" || a["gender"] === "all" ? { gender: a["gender"] as "men" | "women" | "all" } : {}),
              ...(Array.isArray(a["removeInterests"]) ? { removeInterests: a["removeInterests"].filter((x): x is string => typeof x === "string") } : {}),
              ...(Array.isArray(a["addInterests"]) ? { addInterests: a["addInterests"].filter((x): x is string => typeof x === "string") } : {}),
              ...(Array.isArray(a["narrowInterests"]) ? { narrowInterests: a["narrowInterests"].filter((x): x is string => typeof x === "string") } : {}),
              ...(Array.isArray(a["removeBehaviors"]) ? { removeBehaviors: a["removeBehaviors"].filter((x): x is string => typeof x === "string") } : {}),
              ...(Array.isArray(a["addBehaviors"]) ? { addBehaviors: a["addBehaviors"].filter((x): x is string => typeof x === "string") } : {}),
              ...(Array.isArray(a["narrowBehaviors"]) ? { narrowBehaviors: a["narrowBehaviors"].filter((x): x is string => typeof x === "string") } : {}),
              ...(typeof a["radiusKm"] === "number" ? { radiusKm: a["radiusKm"] as number } : {}),
              ...(Array.isArray(a["addressAreas"]) ? { addressAreas: a["addressAreas"].filter((x): x is { address: string; radiusKm: number } => Boolean(x) && typeof (x as { address?: unknown }).address === "string" && typeof (x as { radiusKm?: unknown }).radiusKm === "number").map((x) => ({ address: x.address, radiusKm: x.radiusKm })) } : {}),
              ...(Array.isArray(a["addAudiences"]) ? { addAudiences: a["addAudiences"].filter((x): x is string => typeof x === "string") } : {}),
              ...(Array.isArray(a["excludeAudiences"]) ? { excludeAudiences: a["excludeAudiences"].filter((x): x is string => typeof x === "string") } : {}),
              ...(Array.isArray(a["removeAudiences"]) ? { removeAudiences: a["removeAudiences"].filter((x): x is string => typeof x === "string") } : {}),
              ...(typeof a["distinctCreatives"] === "number" ? { distinctCreatives: a["distinctCreatives"] as number } : {}),
              ...(isMediaPreference(a["mediaPreference"]) ? { mediaPreference: a["mediaPreference"] } : {}),
              ...((): { copyEdits?: ReturnType<typeof parseCopyEdits> } => {
                const edits = parseCopyEdits(a["copyEdits"]);
                return edits.length > 0 ? { copyEdits: edits } : {};
              })(),
              ...((): { setAdCreative?: ReturnType<typeof parseSetAdCreative> } => {
                const sets = parseSetAdCreative(a["setAdCreative"]);
                return sets.length > 0 ? { setAdCreative: sets } : {};
              })(),
            };
      const res = await refineDraft(deps, dctxRefine, active.draftId, patch);
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
      const scaleChoice = args["choice"] === "raise" || args["choice"] === "duplicate" ? (args["choice"] as "raise" | "duplicate") : undefined;
      const strList = (v: unknown): string[] | undefined =>
        Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : undefined;
      const isGender = (v: unknown): v is "all" | "men" | "women" => v === "all" || v === "men" || v === "women";
      const areaList = (v: unknown): { address: string; radiusKm: number }[] | undefined =>
        Array.isArray(v)
          ? v
              .filter((x): x is { address: string; radiusKm: number } => Boolean(x) && typeof (x as { address?: unknown }).address === "string" && typeof (x as { radiusKm?: unknown }).radiusKm === "number")
              .map((x) => ({ address: x.address, radiusKm: x.radiusKm }))
          : undefined;
      const proposal =
        createCall.name === "scale_winner"
          ? await proposeScaleWinner(
              deps,
              dctx,
              typeof args["winnerName"] === "string" ? (args["winnerName"] as string) : undefined,
              "on_demand",
              scaleChoice,
            )
          : createCall.name === "copy_campaign"
            ? await (async () => {
                const inc = strList(args["includeAudiences"]);
                const exc = strList(args["excludeAudiences"]);
                const geo = strList(args["geo"]);
                const interests = strList(args["interests"]);
                const behaviors = strList(args["behaviors"]);
                const addressAreas = areaList(args["addressAreas"]);
                return proposeCopyCampaign(deps, dctx, {
                  sourceCampaignId: String(args["campaignId"] ?? ""),
                  ...(typeof args["campaignName"] === "string" ? { sourceName: args["campaignName"] as string } : {}),
                  ...(inc ? { includeAudiences: inc } : {}),
                  ...(exc ? { excludeAudiences: exc } : {}),
                  ...(typeof args["budgetReais"] === "number" ? { budgetReais: args["budgetReais"] as number } : {}),
                  ...(isConversionGoal(args["goal"]) ? { goal: args["goal"] } : {}),
                  ...(geo ? { geo } : {}),
                  ...(typeof args["ageMin"] === "number" ? { ageMin: args["ageMin"] as number } : {}),
                  ...(typeof args["ageMax"] === "number" ? { ageMax: args["ageMax"] as number } : {}),
                  ...(isGender(args["gender"]) ? { gender: args["gender"] } : {}),
                  ...(interests ? { interests } : {}),
                  ...(behaviors ? { behaviors } : {}),
                  ...(typeof args["radiusKm"] === "number" ? { radiusKm: args["radiusKm"] as number } : {}),
                  ...(addressAreas ? { addressAreas } : {}),
                  ...(typeof args["adCount"] === "number" ? { adCount: args["adCount"] as number } : {}),
                });
              })()
          : await (async () => {
              const inc = strList(args["includeAudiences"]);
              const exc = strList(args["excludeAudiences"]);
              const geo = strList(args["geo"]);
              const interests = strList(args["interests"]);
              const behaviors = strList(args["behaviors"]);
              const addressAreas = areaList(args["addressAreas"]);
              const creatives = strList(args["creatives"]);
              const fill = args["fillRemaining"];
              return proposeCreateCampaign(deps, dctx, {
                ...(typeof args["name"] === "string" && args["name"].trim().length > 0 ? { name: args["name"].trim() } : {}),
                // valida o goal contra a taxonomia neutra ANTES de propor: goal inválido (o LLM
                // manda texto livre) descartado → o propose infere da meta/conta, e o eco mostra
                // o objetivo REAL. Sem isso, um goal fora do enum viraria DEFAULT_OBJECTIVE no
                // adapter, criando campanha (gasto real) com objetivo diferente do prometido (§8).
                ...(isConversionGoal(args["goal"]) ? { goal: args["goal"] } : {}),
                ...(typeof args["budgetReais"] === "number" ? { budgetReais: args["budgetReais"] as number } : {}),
                ...(inc ? { includeAudiences: inc } : {}),
                ...(exc ? { excludeAudiences: exc } : {}),
                ...(geo ? { geo } : {}),
                ...(typeof args["ageMin"] === "number" ? { ageMin: args["ageMin"] as number } : {}),
                ...(typeof args["ageMax"] === "number" ? { ageMax: args["ageMax"] as number } : {}),
                ...(isGender(args["gender"]) ? { gender: args["gender"] } : {}),
                ...(interests ? { interests } : {}),
                ...(behaviors ? { behaviors } : {}),
                ...(typeof args["radiusKm"] === "number" ? { radiusKm: args["radiusKm"] as number } : {}),
                ...(addressAreas ? { addressAreas } : {}),
                ...(typeof args["adCount"] === "number" ? { adCount: args["adCount"] as number } : {}),
                ...(typeof args["distinctCreatives"] === "number" ? { distinctCreatives: args["distinctCreatives"] as number } : {}),
                ...(isMediaPreference(args["mediaPreference"]) ? { mediaPreference: args["mediaPreference"] } : {}),
                ...(creatives && creatives.length > 0 ? { creatives } : {}),
                ...(fill === "agent" || fill === "only_picked" ? { fillRemaining: fill } : {}),
                ...(typeof args["link"] === "string" && args["link"].trim().length > 0 ? { link: args["link"].trim() } : {}),
              });
            })();
      const expiresAt = new Date(Date.now() + PENDING_WRITE_TTL_MS).toISOString();
      if (proposal.kind === "blocked") {
        return { messages: [...answerToolCalls(allCalls, "não deu"), new AIMessage(proposal.reason)] };
      }
      if (proposal.kind === "ask") {
        // passo agressivo, intent aberto → o agente PERGUNTA; sem pending (nada a confirmar
        // ainda). O usuário responde "sobe o budget"/"duplica" → o LLM re-chama scale_winner
        // com choice → vira ação (raise) ou rascunho (duplicate).
        return { messages: [...answerToolCalls(allCalls, "perguntando"), new AIMessage(proposal.echo)] };
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
      const modes: ("pause" | "archive")[] = [];
      for (const c of revertCalls) {
        const a = (c.args ?? {}) as { toolCallId?: string; label?: string; actionType?: string; mode?: "pause" | "archive" };
        if (!a.toolCallId) continue;
        const mode = a.mode === "archive" ? "archive" : "pause";
        items.push({ label: a.label ?? "essa ação", actionType: a.actionType ?? "", mode });
        ids.push(a.toolCallId);
        modes.push(mode);
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
        pendingRevert: { echo, expiresAt: new Date(Date.now() + PENDING_WRITE_TTL_MS).toISOString(), toolCallIds: ids, modes },
        pendingWrite: null, // uma pendência por vez (write × revert não coexistem)
      };
    }

    // CONFIG POR CHAT (S2.3–S2.6): ramo próprio ANTES da escrita Meta (config não toca a
    // Meta → sem guardrail/dry-run de ads). Monta o eco determinístico + congela a mudança.
    const configCalls = allCalls.filter((c) => isConfirmableConfigTool(c.name));
    if (configCalls.length > 0) {
      // Concierge (grupo multi-conta): config precisa de UMA conta em foco. Sem `agentId` (o
      // set_focus não rodou antes nesta rodada), NÃO monta um eco quebrado — pede pra focar
      // (o próximo passo/turno já opera na conta). Fix same-turn: com set_focus rodando antes,
      // o ctx.agentId já vem preenchido e cai nos ramos normais abaixo.
      if (!ctx.agentId) {
        return {
          messages: answerToolCalls(
            allCalls,
            'Me diz em qual conta focar primeiro (ex: "foca na Loja X") que aí eu ajusto a configuração dela por aqui mesmo.',
          ),
        };
      }
      // config + escrita Meta no MESMO turno: não engula a escrita em silêncio — peça
      // uma coisa de cada vez (o gate trata 1 pendência por turno). §UX: nunca sumir com o pedido.
      // Cobre TODA escrita/criação/edição especial (não só WRITE_TOOL_NAMES) — senão "muda a meta
      // e edita o público" ecoaria só a config e sumiria com a edição.
      const alsoMetaWrite = allCalls.some(
        (c) =>
          WRITE_TOOL_NAMES.has(c.name) ||
          CREATE_TOOL_NAMES.has(c.name) ||
          REFINE_TOOL_NAMES.has(c.name) ||
          c.name === EDIT_AUDIENCE_TOOL_NAME ||
          c.name === REALLOCATE_TOOL_NAME ||
          c.name === REVERT_TOOL_NAME,
      );
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

    // EDITAR PÚBLICO de adset vivo (A1): resolve o público por NOMES (nome→id via search; dono
    // presente → ambíguo PERGUNTA), monta a Action adjust_audience, guardrail (drop honesto se a
    // ação não estiver liberada) + dry-run, e ecoa o novo público com o aviso de reset de aprendizado.
    const editCall = allCalls.find((c) => c.name === EDIT_AUDIENCE_TOOL_NAME);
    if (editCall) {
      const a = (editCall.args ?? {}) as Record<string, unknown>;
      const adsetId = typeof a["adsetId"] === "string" ? a["adsetId"].trim() : "";
      const adsetName = typeof a["adsetName"] === "string" && a["adsetName"] ? (a["adsetName"] as string) : adsetId;
      if (!adsetId) {
        return { messages: answerToolCalls(allCalls, "Me diz qual conjunto de anúncios (o nome que eu identifico) que eu ajusto o público.") };
      }
      const wctx = await loadWriteContext(deps, ctx.orgId, ctx.agentId, [{ level: "adset", id: adsetId, name: adsetName }]);
      if (!wctx) {
        return { messages: answerToolCalls(allCalls, "Não consegui acessar a conta agora. Tenta de novo em instantes.") };
      }
      const strList = (v: unknown): string[] | undefined => {
        if (!Array.isArray(v)) return undefined;
        const out = v.filter((x): x is string => typeof x === "string");
        return out.length > 0 ? out : undefined;
      };
      const isGender = (v: unknown): v is "all" | "men" | "women" => v === "all" || v === "men" || v === "women";
      const geo = strList(a["geo"]);
      const interests = strList(a["interests"]);
      const behaviors = strList(a["behaviors"]);
      const includeAudiences = strList(a["includeAudiences"]);
      const excludeAudiences = strList(a["excludeAudiences"]);
      const input: ProposedExplicitInput = {
        ...(geo ? { geo } : {}),
        ...(typeof a["ageMin"] === "number" ? { ageMin: a["ageMin"] } : {}),
        ...(typeof a["ageMax"] === "number" ? { ageMax: a["ageMax"] } : {}),
        ...(isGender(a["gender"]) ? { gender: a["gender"] } : {}),
        ...(interests ? { interests } : {}),
        ...(behaviors ? { behaviors } : {}),
        ...(includeAudiences ? { includeAudiences } : {}),
        ...(excludeAudiences ? { excludeAudiences } : {}),
        ...(typeof a["radiusKm"] === "number" ? { radiusKm: a["radiusKm"] } : {}),
      };
      const dctxEdit: DraftProposalContext = { orgId: ctx.orgId, agentId: ctx.agentId, adAccountId: ctx.adAccountId, currency: DEFAULT_CURRENCY };
      const res = await resolveProposedExplicitTargeting(deps, dctxEdit, wctx.account, input, { autonomous: false });
      if (res.kind === "blocked") {
        return { messages: [...answerToolCalls(allCalls, "preciso esclarecer"), new AIMessage(res.reason)] };
      }
      if (res.kind === "empty") {
        return {
          messages: [
            ...answerToolCalls(allCalls, "sem público"),
            new AIMessage('Não entendi qual público você quer no conjunto. Me diz o essencial (ex: "BH e região, 25-45, interesse em corrida").'),
          ],
        };
      }
      const action: Action = {
        id: editCall.id ?? EDIT_AUDIENCE_TOOL_NAME,
        type: "adjust_audience",
        target: { level: "adset", id: adsetId, name: adsetName },
        params: { [ACTION_PARAM_TARGETING]: res.targeting },
        source: "llm",
        riskLevel: riskForAction("adjust_audience"),
        reason: "edição de público pedida no chat",
      };
      const check = applyGuardrails([action], wctx.cfg, wctx.ctx);
      if (check.allowed.length === 0) {
        const reason = check.dropped[0]?.reason ?? "editar público está desligado para este agente";
        return { messages: [...answerToolCalls(allCalls, "não consigo"), new AIMessage(`Não consigo editar o público: ${reason}`)] };
      }
      const clamped = check.allowed[0]!;
      try {
        await deps.ports.ads.mutate(wctx.account, clamped, { dryRun: true });
      } catch (err) {
        logger.warn({ err, adsetId }, "conversation:dry-run do edit_audience falhou");
        return { messages: [...answerToolCalls(allCalls, "não deu"), new AIMessage("Não consegui simular essa edição de público agora — tenta de novo em instantes.")] };
      }
      const drops = res.droppedNames.length > 0 ? `\n(não achei: ${res.droppedNames.join(", ")})` : "";
      const sim = wctx.cfg.dryRun ? "Modo simulação (não aplico de verdade): " : "";
      const echo = `${sim}Vou trocar o público do conjunto *${adsetName}*${acctLbl} para: ${describeExplicitAudience(res.targeting)}.${drops}\n\n⚠️ Editar o público reinicia o aprendizado da Meta desse conjunto.\n\nConfirma?`;
      return {
        messages: [...answerToolCalls(allCalls, "proposto — aguardando confirmação"), new AIMessage(echo)],
        pendingWrite: { echo, expiresAt: new Date(Date.now() + PENDING_WRITE_TTL_MS).toISOString(), actions: [clamped] },
        pendingRevert: null,
      };
    }

    // REALOCAR ORÇAMENTO A→B (A4): move um valor/dia da origem pro destino. Lê os dois budgets
    // FRESCOS, pré-clampa ao teto de blast-radius (o MAIOR movível respeitando os DOIS lados) p/
    // as pernas ficarem balanceadas, e monta 2 adjust_budget set-absoluto marcadas como SAGA
    // (aplica sequencial com compensação no apply). Guardrail nas duas pernas; nunca auto-aplica.
    const reallocCall = allCalls.find((c) => c.name === REALLOCATE_TOOL_NAME);
    if (reallocCall) {
      const a = (reallocCall.args ?? {}) as Record<string, unknown>;
      // origem e destino têm NÍVEL próprio (Gap 6): dá pra mover de uma campanha CBO pra um conjunto
      // ABO, não só entre pares do mesmo nível. A saga é level-agnóstica (2 Actions independentes).
      const fromLevel = a["fromLevel"] === "adset" ? "adset" : "campaign";
      const toLevel = a["toLevel"] === "adset" ? "adset" : "campaign";
      const fromId = typeof a["fromEntityId"] === "string" ? a["fromEntityId"].trim() : "";
      const toId = typeof a["toEntityId"] === "string" ? a["toEntityId"].trim() : "";
      const fromName = typeof a["fromEntityName"] === "string" && a["fromEntityName"] ? (a["fromEntityName"] as string) : fromId;
      const toName = typeof a["toEntityName"] === "string" && a["toEntityName"] ? (a["toEntityName"] as string) : toId;
      const amountReais = typeof a["amountReais"] === "number" ? a["amountReais"] : NaN;
      if (!fromId || !toId || !(amountReais > 0)) {
        return { messages: answerToolCalls(allCalls, "Me diz de qual entidade tirar, pra qual pôr e quanto por dia (ex: 'R$ 50/dia da campanha A pra B').") };
      }
      const fromTarget: Action["target"] = { level: fromLevel, id: fromId, name: fromName };
      const toTarget: Action["target"] = { level: toLevel, id: toId, name: toName };
      if (entityKeyOf(fromTarget) === entityKeyOf(toTarget)) {
        return { messages: answerToolCalls(allCalls, "A origem e o destino são a mesma entidade — me diz duas diferentes.") };
      }
      const wctx = await loadWriteContext(deps, ctx.orgId, ctx.agentId, [fromTarget, toTarget]);
      if (!wctx) {
        return { messages: answerToolCalls(allCalls, "Não consegui acessar a conta agora. Tenta de novo em instantes.") };
      }
      const fromKey = entityKeyOf(fromTarget);
      const toKey = entityKeyOf(toTarget);
      const fromCur = wctx.ctx.budgetAmountByEntity?.get(fromKey);
      const toCur = wctx.ctx.budgetAmountByEntity?.get(toKey);
      if (fromCur === undefined || toCur === undefined) {
        // a perna sem orçamento pode estar em outro nível (CBO/ABO) → oferta honesta por-perna
        // (reusa a resolução da Fatia 2), senão mensagem genérica (falha transiente).
        const leg = fromCur === undefined ? fromTarget : toTarget;
        if (wctx.ctx.budgetByEntity?.get(entityKeyOf(leg)) === false) {
          try {
            const msg = await resolveMisplacedBudgetMessage(deps.ports.ads, wctx.account, leg.level as "campaign" | "adset", leg.id, leg.name ?? leg.id, acctLbl);
            if (msg) return { messages: [...answerToolCalls(allCalls, "orçamento em outro nível"), new AIMessage(msg)] };
          } catch (err) {
            logger.warn({ err, entityId: leg.id }, "conversation:resolução de nível na realocação falhou");
          }
        }
        return { messages: [...answerToolCalls(allCalls, "sem budget"), new AIMessage(`Não consegui ler o orçamento de *${leg.name ?? leg.id}* — pode ser que o orçamento esteja em outro nível (ex: na campanha, não no conjunto). Dá uma olhada no site.`)] };
      }
      // tipo do orçamento (diário/vitalício) por perna: rotula o eco certo e barra misturar tipos —
      // mover "X/dia" de um diário pra um vitalício (ou vice-versa) não é coerente (um é por dia, o
      // outro é o total do período).
      const fromKind = wctx.budgetKindByEntity.get(fromKey) ?? "daily";
      const toKind = wctx.budgetKindByEntity.get(toKey) ?? "daily";
      const kindCheck = reallocKindPeriod(fromKind, toKind);
      if (!kindCheck.ok) {
        const describeKind = (k: BudgetPeriodKind) => (k === "lifetime" ? "vitalício (total)" : "diário (por dia)");
        return { messages: [...answerToolCalls(allCalls, "tipos diferentes"), new AIMessage(`*${fromName}* usa orçamento ${describeKind(fromKind)} e *${toName}* usa ${describeKind(toKind)} — não dá pra realocar entre tipos de orçamento diferentes. Ajusto cada um separado, ou você faz no site.`)] };
      }
      const period = kindCheck.period;
      const requestedMinor = toMinorUnits(amountReais, wctx.currency);
      if (requestedMinor >= fromCur) {
        return { messages: [...answerToolCalls(allCalls, "valor alto demais"), new AIMessage(`Esse valor esvaziaria *${fromName}* (orçamento atual ${formatMoneyMinor(fromCur, wctx.currency)}${period}). Me diz um valor menor pra mover.`)] };
      }
      // pré-clamp: o maior movível respeitando o teto de % nos DOIS lados (origem −%, destino +%).
      const maxMovableMinor = Math.floor((wctx.cfg.maxBudgetChangePct / 100) * Math.min(fromCur, toCur));
      // ...E respeitando o PISO da plataforma na origem: se `fromCur - move` cair abaixo de
      // MIN_BUDGET_MINOR, o executor arredondaria a origem PRA CIMA (pro piso) e o aplicado
      // divergiria do eco (origem não cai o prometido, destino sobe tudo → gasto total sobe sem
      // aviso). Limita o move pra a origem parar EXATAMENTE no piso, não abaixo.
      const maxMovableByFloor = fromCur - MIN_BUDGET_MINOR;
      const moveMinor = Math.min(requestedMinor, maxMovableMinor, Math.max(0, maxMovableByFloor));
      if (moveMinor <= 0) {
        // origem já no piso → não dá pra tirar sem furar o mínimo; senão foi o teto de %.
        const atFloor = maxMovableByFloor <= 0;
        const msg = atFloor
          ? `*${fromName}* já está no orçamento mínimo (${formatMoneyMinor(MIN_BUDGET_MINOR, wctx.currency)}${period}) — não dá pra tirar mais dela sem parar a campanha. Pausa no site se for isso que você quer.`
          : `Com o seu limite de segurança de ${wctx.cfg.maxBudgetChangePct}% por mudança, não consigo mover nada de uma vez entre essas duas. Dá pra afrouxar o teto na config, ou mover no site.`;
        return { messages: [...answerToolCalls(allCalls, "não movo"), new AIMessage(msg)] };
      }
      // nota honesta do porquê reduziu: distingue o PISO (origem pararia abaixo do mínimo) do TETO de
      // % — antes atribuía tudo ao teto mesmo quando foi o piso que cortou (eco enganoso).
      const clampedNote =
        moveMinor >= requestedMinor
          ? ""
          : maxMovableByFloor <= maxMovableMinor
            ? `\n(movo ${formatMoneyMinor(moveMinor, wctx.currency)}${period} — mais que isso deixaria *${fromName}* abaixo do orçamento mínimo)`
            : `\n(respeitando seu teto de ${wctx.cfg.maxBudgetChangePct}%, movo ${formatMoneyMinor(moveMinor, wctx.currency)}${period} — o máximo seguro de uma vez)`;
      const legFrom: Action = {
        id: `${reallocCall.id ?? REALLOCATE_TOOL_NAME}:from`,
        type: "adjust_budget",
        target: fromTarget,
        params: { [ACTION_PARAM_MODE]: BUDGET_MODE_SET, [ACTION_PARAM_AMOUNT_MINOR]: fromCur - moveMinor },
        source: "llm",
        riskLevel: riskForAction("adjust_budget"),
        reason: "realocação de orçamento pedida no chat (origem)",
      };
      const legTo: Action = {
        id: `${reallocCall.id ?? REALLOCATE_TOOL_NAME}:to`,
        type: "adjust_budget",
        target: toTarget,
        params: { [ACTION_PARAM_MODE]: BUDGET_MODE_SET, [ACTION_PARAM_AMOUNT_MINOR]: toCur + moveMinor },
        source: "llm",
        riskLevel: riskForAction("adjust_budget"),
        reason: "realocação de orçamento pedida no chat (destino)",
      };
      const check = applyGuardrails([legFrom, legTo], wctx.cfg, wctx.ctx);
      // realocação é BALANCEADA — só faz sentido com as DUAS pernas. Se o guardrail barrar
      // ou clampar qualquer uma (killswitch/ação-desligada/cap-diário/budget-já-mexido), não
      // faço uma metade: reporto honesto e não mexo em nada.
      const clampedFrom = check.allowed.find((x) => entityKeyOf(x.target) === fromKey);
      const clampedTo = check.allowed.find((x) => entityKeyOf(x.target) === toKey);
      const unchanged = (orig: Action, got: Action | undefined) =>
        got !== undefined && got.params[ACTION_PARAM_AMOUNT_MINOR] === orig.params[ACTION_PARAM_AMOUNT_MINOR];
      if (!unchanged(legFrom, clampedFrom) || !unchanged(legTo, clampedTo)) {
        const reason = check.dropped[0]?.reason ?? "uma das pernas não passou no limite de segurança";
        return { messages: [...answerToolCalls(allCalls, "não consigo realocar"), new AIMessage(`Não consigo fazer essa realocação agora: ${reason}. Não mexi em nada.`)] };
      }
      let dryOk = true;
      for (const leg of [clampedFrom!, clampedTo!]) {
        try {
          await deps.ports.ads.mutate(wctx.account, leg, { dryRun: true });
        } catch (err) {
          logger.warn({ err, entityId: leg.target.id }, "conversation:dry-run da realocação falhou");
          dryOk = false;
        }
      }
      if (!dryOk) {
        return { messages: [...answerToolCalls(allCalls, "não deu"), new AIMessage("Não consegui simular essa realocação agora — tenta de novo em instantes.")] };
      }
      const sim = wctx.cfg.dryRun ? "Modo simulação (não aplico de verdade): " : "";
      const echo =
        `${sim}Vou mover ${formatMoneyMinor(moveMinor, wctx.currency)}${period}${acctLbl}:\n` +
        `• *${fromName}* cai pra ${formatMoneyMinor(fromCur - moveMinor, wctx.currency)}${period}\n` +
        `• *${toName}* sobe pra ${formatMoneyMinor(toCur + moveMinor, wctx.currency)}${period}${clampedNote}\n\nConfirma?`;
      return {
        messages: [...answerToolCalls(allCalls, "proposto — aguardando confirmação"), new AIMessage(echo)],
        pendingWrite: {
          echo,
          expiresAt: new Date(Date.now() + PENDING_WRITE_TTL_MS).toISOString(),
          actions: [clampedFrom!, clampedTo!],
          saga: { kind: "reallocation", sourceKey: fromKey, sourceRestoreMinor: fromCur },
        },
        pendingRevert: null,
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

    // Onde mora o orçamento (Gaps 1+2): mensagens honestas quando um adjust_budget mira um nível SEM
    // orçamento próprio. NÃO aborta as OUTRAS ações do lote — a ação mal-localizada é ANOTADA (nunca
    // dropada em silêncio) e as demais seguem. Nunca retargeta em silêncio (CBO afeta todos os conjuntos).
    const budgetLocationNotes: string[] = [];
    // Gap 2 (anúncio nunca tem orçamento na Meta): detecta ANTES de tocar a Meta (sem custo/erro #100).
    const nonAdBudget: Action[] = [];
    for (const a of proposed) {
      if (a.type === "adjust_budget" && a.target.level === "ad") {
        budgetLocationNotes.push(adHasNoBudgetMessage(a.target.name ?? a.target.id, acctLbl));
      } else {
        nonAdBudget.push(a);
      }
    }
    if (nonAdBudget.length === 0) {
      // só pedido(s) de orçamento em anúncio → devolve as explicações (sem tocar a Meta).
      return { messages: [...answerToolCalls(allCalls, "anúncio não tem orçamento"), new AIMessage(budgetLocationNotes.join("\n\n"))] };
    }

    const wctx = await loadWriteContext(deps, ctx.orgId, ctx.agentId, nonAdBudget.map((a) => a.target));
    if (!wctx) {
      return { messages: answerToolCalls(allCalls, "Não consegui acessar a conta agora. Tenta de novo em instantes.") };
    }

    // budget set-absoluto do chat vem na unidade MAIOR (amountMajor) — converte p/ unidade menor
    // AGORA que a moeda da conta é conhecida (JPY≠centavos). Antes disso o guardrail/mutação nem
    // enxergariam o valor. No-op p/ pause/status/pct.
    const resolvedAll = nonAdBudget.map((a) => resolveBudgetMinor(a, wctx.currency));

    // Gap 1 (CBO/ABO): nível sem orçamento próprio (leitura fresca OK e budget ausente) → oferta
    // honesta por-ação; a ação sai do lote (anotada), as demais seguem.
    const resolved: Action[] = [];
    for (const a of resolvedAll) {
      if (
        a.type === "adjust_budget" &&
        (a.target.level === "campaign" || a.target.level === "adset") &&
        wctx.ctx.budgetByEntity?.get(entityKeyOf(a.target)) === false
      ) {
        try {
          const msg = await resolveMisplacedBudgetMessage(deps.ports.ads, wctx.account, a.target.level, a.target.id, a.target.name ?? a.target.id, acctLbl);
          if (msg) {
            budgetLocationNotes.push(msg);
            continue; // ação mal-localizada anotada — não segue pro eco/apply
          }
        } catch (err) {
          logger.warn({ err, entityId: a.target.id }, "conversation:resolução de nível de orçamento falhou — segue fluxo normal");
        }
      }
      resolved.push(a);
    }

    // Ativação em cadeia (a Meta não cascateia status): ativar campanha/conjunto religa a subárvore
    // pausada, senão só o nó liga e a campanha não veicula. Leitura da árvore best-effort (falha →
    // só o nó). pause/→PAUSED não expande. Feito ANTES do guardrail p/ contar/isentar a árvore inteira.
    const chain = await expandChainActivation(
      resolved,
      async (level, id) => {
        try {
          return await deps.ports.ads.readActivationTree(wctx.account, level, id);
        } catch (err) {
          logger.warn({ err, entityId: id }, "conversation:leitura da árvore de ativação falhou — só o nó");
          return null;
        }
      },
      { resumeAllowed: wctx.cfg.allowedActions.includes("resume_entity") },
    );

    // guardrail no LOTE inteiro (uma chamada) — senão o cap de entidades/dia não acumula
    // entre as ações do mesmo turno (seenEntities é por-chamada). §8: guardrail sempre. A ativação
    // em cadeia CONFIRMADA isenta SÓ o cap de entidades/dia (intenção única; killSwitch/budget seguem).
    const check = applyGuardrails(chain.expanded, wctx.cfg, wctx.ctx, { exemptEntityCap: chain.chainActivated });
    const labelOf = (a: Action) => a.target.name ?? a.target.id;
    const blocked = check.dropped.map((d) => `${labelOf(d.action)}: ${d.reason}`);

    const echoItems: EchoItem[] = [];
    const frozen: Action[] = [];
    for (const clamped of check.allowed) {
      // ações-filho da cadeia entram no lote a aplicar, mas NÃO no eco (senão vira uma linha por
      // filho) — o resumo delas sai na nota de listagem (`chain.notes`).
      if (chain.childIds.has(clamped.id)) {
        frozen.push(clamped);
        continue;
      }
      try {
        const dry = await deps.ports.ads.mutate(wctx.account, clamped, { dryRun: true });
        echoItems.push({
          action: clamped,
          before: dry.before as Record<string, unknown>,
          after: dry.after as Record<string, unknown>,
          entityName: clamped.target.name ?? clamped.target.id,
          currency: wctx.currency,
          // nomeia a conta no eco só em org multi-conta (evita ruído em org de 1 conta).
          ...(showAccount ? { accountName: ctx.accountName! } : {}),
        });
        frozen.push(clamped);
      } catch (err) {
        logger.warn({ err, entityId: clamped.target.id }, "conversation:dry-run do eco falhou");
        blocked.push(`${labelOf(clamped)}: não consegui simular agora`);
      }
    }

    const parts: string[] = [];
    // shadow (dry_run): o eco avisa que vai SIMULAR — senão "vou pausar" soa como escrita real.
    if (wctx.cfg.dryRun && echoItems.length > 0) parts.push("Modo simulação (não aplico de verdade):");
    if (echoItems.length > 0) parts.push(buildWriteEcho(echoItems));
    // notas da ativação em cadeia (o que liga além do nó / ⚠️ não-entrega) + aviso de teto.
    for (const note of chain.notes) parts.push(note);
    // aviso de teto: conta o lote + o que já foi tocado hoje (cross-run) vs o cap (a isenção real
    // no guardrail também considera touchedToday) — senão o aviso não bate com o consumo do dia.
    const dayTotal = new Set([...(wctx.ctx.touchedToday ?? []), ...frozen.map((a) => entityKeyOf(a.target))]).size;
    if (chain.chainActivated && dayTotal > wctx.cfg.maxEntitiesPerDay) parts.push(capWarningNote(dayTotal, wctx.cfg.maxEntitiesPerDay));
    if (blocked.length > 0) parts.push(`Não consigo:\n${blocked.map((b, i) => `${i + 1}. ${b}`).join("\n")}`);
    // ofertas de "onde mora o orçamento" (Gaps 1+2): entram no MESMO eco das demais ações (não dropam
    // as outras) — ou são a resposta inteira quando todo o pedido era orçamento mal-localizado.
    for (const note of budgetLocationNotes) parts.push(note);
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
        ...(chain.chainActivated ? { chainActivation: true } : {}),
      };
    }
    return update;
  }

  /** Turno 2: aplica (confirm_write) ou descarta (cancel_write) a pendência congelada. */
  async function applyWrite(state: WhatsappConversationStateType): Promise<WhatsappConversationUpdate> {
    const last = state.messages.at(-1) as AIMessage | undefined;
    const calls = last?.tool_calls ?? [];
    const isConfirm = calls.some((c) => c.name === "confirm_write");
    const dctx = { orgId: ctx.orgId, agentId: ctx.agentId, adAccountId: ctx.adAccountId, currency: DEFAULT_CURRENCY };
    // nada mais pendente no estado → a única pendência possível é um rascunho aberto no banco (TTL
    // expirou); usado por reject/confirm p/ recuperar sem shadowear write/revert/config ativos.
    const noOtherPending =
      !activePendingWrite(state.pendingWrite) && !activePendingRevert(state.pendingRevert) && !activePendingConfig(state.pendingConfigChange);

    if (!isConfirm) {
      // recusa em-turno de um RASCUNHO → resolve a approval no BANCO (some do site também),
      // não só limpa o estado efêmero (senão o rascunho seguia pendente 24h no card). As demais
      // pendências (write/revert/config) não têm approval persistida aqui. Estado expirou mas o
      // rascunho segue aberto no banco → recupera p/ "descarta" funcionar mesmo depois de 30min.
      const rejectedDraft = activePendingDraft(state.pendingDraft) ?? (noOtherPending ? await recoverOrNull(deps, dctx) : null);
      if (rejectedDraft) {
        // só recusa se AINDA pendente: o rascunho pode ter sido aprovado por id nesse meio-tempo
        // (apply-service já criou a campanha) → não reverter approved→rejected com a campanha viva.
        // Espelha o guard de approve/reject (getById + status pending).
        const appr = await deps.ports.approval.getById(rejectedDraft.approvalId as ApprovalId);
        if (appr && appr.status === "pending") {
          await deps.ports.approval.resolve(rejectedDraft.approvalId as ApprovalId, { status: "rejected" });
        }
      }
      return {
        messages: [
          ...answerToolCalls(calls, "cancelado"),
          new AIMessage(rejectedDraft ? "Ok, descartei o rascunho." : "Ok, não mexi em nada."),
        ],
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
      await deps.ports.scheduler.enqueue(
        buildApprovalApplyJob({ orgId: ctx.orgId, approvalId: pendingDraft.approvalId, notifyRef: ctx.ref }),
      );
      return {
        messages: [...answerToolCalls(calls, "criando"), new AIMessage("Beleza, tô criando — te aviso quando ficar pronto.")],
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
      for (let i = 0; i < pendingRevert.toolCallIds.length; i++) {
        const toolCallId = pendingRevert.toolCallIds[i]!;
        const mode = pendingRevert.modes?.[i] ?? "pause"; // estado antigo sem modes → pausar
        const res = await revertActionById(deps, { orgId: ctx.orgId, toolCallId, mode });
        lines.push(
          res.reverted
            ? mode === "archive"
              ? "Arquivada."
              : "Desfeito."
            : res.blockedByDrift
              ? `Não desfiz: ${res.reason ?? "a entidade mudou desde a ação"}. Se quiser desfazer mesmo assim, me avise.`
              : `Não consegui desfazer: ${res.reason ?? "ação não encontrada"}.`,
        );
      }
      return { messages: [...answerToolCalls(calls, "revert"), new AIMessage(lines.join("\n"))], pendingRevert: null, pendingWrite: null };
    }

    // "sim" TARDIO (estado expirou) mas o rascunho segue aberto no banco → NÃO aplica às cegas:
    // re-ecoa o que está proposto (passou muito tempo) e pede confirmação de novo (§8 eco+confirma).
    const recovered = noOtherPending ? await recoverOrNull(deps, dctx) : null;
    if (recovered) {
      return {
        messages: [
          ...answerToolCalls(calls, "reconfirmar"),
          new AIMessage(`Esse rascunho ficou um tempo esperando, então confiro com você antes de criar:\n\n${recovered.echo}`),
        ],
        pendingDraft: recovered,
      };
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

    // SAGA de realocação A→B (A4): NÃO é atômica na Meta → aplica a origem, depois o destino;
    // se o destino falha, DEVOLVE o orçamento da origem (compensação); se a devolução também
    // falha, reporta o estado parcial explícito (nunca silêncio). Reusa o mesmo apply-checado.
    if (pending.saga?.kind === "reallocation") {
      const saga = pending.saga;
      const legFrom = pending.actions[0];
      const legTo = pending.actions[1];
      if (!legFrom || !legTo) {
        return { messages: [...answerToolCalls(calls, "estado inválido"), new AIMessage("Perdi os detalhes dessa realocação. Me pede de novo.")], pendingWrite: null };
      }
      const fromName = legFrom.target.name ?? legFrom.target.id;
      const toName = legTo.target.name ?? legTo.target.id;
      const applyLeg = (action: Action, ctxOver: GuardrailContext, keySuffix: string): Promise<ApplyResult> =>
        applyCheckedAction({
          executor,
          account: wctx.account,
          action,
          cfg: wctx.cfg,
          ctx: ctxOver,
          agentId: ctx.agentId,
          runId: null,
          orgId: ctx.orgId,
          idempotencyKey: `conv:${ctx.conversationId}:${action.id}:${keySuffix}`,
        });

      // orquestração da saga (ordem + compensação) é PURA-ish (testável); aqui só renderiza o desfecho.
      const outcome = await runReallocationSaga(legFrom, legTo, saga, wctx.ctx, applyLeg);
      switch (outcome.kind) {
        case "source_failed":
          return {
            messages: [...answerToolCalls(calls, "realocação abortada"), new AIMessage(`Não consegui mexer no orçamento de *${fromName}* (${reallocFailReason(outcome.failed)}), então não movi nada.`)],
            pendingWrite: null,
          };
        case "done":
          return {
            messages: [...answerToolCalls(calls, "realocado"), new AIMessage(describeActionOutcome(legFrom, { kind: wctx.cfg.dryRun ? "simulated" : "applied" }) + "\n" + describeActionOutcome(legTo, { kind: wctx.cfg.dryRun ? "simulated" : "applied" }))],
            pendingWrite: null,
          };
        case "compensated":
          return {
            messages: [...answerToolCalls(calls, "realocação revertida"), new AIMessage(`Não consegui aumentar *${toName}* (${reallocFailReason(outcome.destFailed)}), então devolvi o orçamento de *${fromName}*. No fim, nada mudou.`)],
            pendingWrite: null,
          };
        case "partial": {
          // devolução TAMBÉM falhou → estado parcial explícito (jamais silêncio). §UX erro = o quê + o quê fazer.
          const leftMinor = Number(legFrom.params[ACTION_PARAM_AMOUNT_MINOR]);
          const leftMoney = Number.isFinite(leftMinor) ? formatMoneyMinor(leftMinor, wctx.currency) : "um valor menor";
          logger.error({ fromId: legFrom.target.id, toId: legTo.target.id }, "realloc:compensação falhou — estado parcial");
          return {
            messages: [...answerToolCalls(calls, "estado parcial"), new AIMessage(`⚠️ Reduzi *${fromName}* mas não consegui aumentar *${toName}* nem devolver o orçamento. *${fromName}* está com ${leftMoney}/dia agora — dá uma olhada no site e ajuste se precisar.`)],
            pendingWrite: null,
          };
        }
      }
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
        // ativação em cadeia confirmada isenta o cap de entidades/dia (intenção única do dono).
        ...(pending.chainActivation ? { exemptEntityCap: true } : {}),
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
        c.name === EDIT_AUDIENCE_TOOL_NAME ||
        c.name === REALLOCATE_TOOL_NAME ||
        c.name === REVERT_TOOL_NAME ||
        c.name === DESCRIBE_CAPABILITIES_TOOL_NAME ||
        c.name === WHATSAPP_NUMBER_TOOL_NAME ||
        isConfirmableConfigTool(c.name),
    )
  )
    return "confirm";
  return "tools";
}
