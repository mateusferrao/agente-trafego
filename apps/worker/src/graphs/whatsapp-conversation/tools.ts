// Catálogo de tools do agente conversacional (allowlist por turno).
// 5b-2.2: LEITURA (sobre nosso DB curado — read-data.ts) + `trigger_analysis`
// (dispara análise on-demand com push de volta na conversa). Nenhuma tool chama a
// Meta. Tools de ESCRITA (aprovar/rejeitar) entram na 5b-2.3.

import { and, eq, ilike } from "drizzle-orm";
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { adAccounts, conversations } from "@trafego/db";
import {
  ACTION_PARAM_AMOUNT_MINOR,
  ACTION_PARAM_MODE,
  ACTION_PARAM_PCT,
  ACTION_PARAM_STATUS,
  APPROVAL_APPLY_JOB,
  APPROVAL_APPLY_QUEUE,
  BUDGET_MODE_SET,
  type ActionType,
  type ApprovalId,
  type EntityLevel,
} from "@trafego/shared";
import type { Action } from "@trafego/shared/types";
import type { WorkerDeps } from "../../composition.js";
import { createRunDispatcher } from "../../modules/dispatch/run-dispatcher.js";
import { makeReadTools, type ReadToolContext } from "./read-data.js";

export interface ConversationToolContext extends ReadToolContext {
  /** thread da conversa (checkpointer) — alvo do push do "analisa agora". */
  readonly conversationId: string;
  /** org com >1 conta ativa (concierge/multi-conta) — o eco nomeia a conta (5c-6). */
  readonly multiAccount?: boolean;
  /** nome da conta em foco/contexto (exibição no eco, org multi-conta). */
  readonly accountName?: string;
}

/**
 * Monta as tools do turno, filtradas pela allowlist. `allow` = nomes ligados
 * (5b-2.2 = read + trigger; concierge multi-conta = só as org-level).
 */
export function makeConversationTools(
  deps: WorkerDeps,
  ctx: ConversationToolContext,
  allow: ReadonlySet<string>,
) {
  const { logger } = deps;
  const readTools = makeReadTools(deps, ctx);

  const dispatcher = createRunDispatcher({
    db: deps.db,
    scheduler: deps.ports.scheduler,
    logger,
    metering: deps.ports.metering,
    envCostCapUsd: deps.costCapUsd,
  });

  // "analisa agora": dispara run on-demand (origem conversa) + push do resultado de volta.
  const triggerAnalysis = tool(
    async () => {
      const outcome = await dispatcher.dispatch({
        orgId: ctx.orgId,
        agentId: ctx.agentId,
        adAccountId: ctx.adAccountId,
        trigger: "conversation",
        notify: { contactId: ctx.contactId, conversationId: ctx.conversationId },
      });
      logger.debug({ agentId: ctx.agentId, outcome }, "tool:trigger_analysis");
      // devolve ao modelo o desfecho p/ ele responder com honestidade (§UX).
      if (outcome === "enqueued") return "Análise iniciada — leva ~1 min; devolvo o resultado aqui.";
      if (outcome === "skipped_in_flight") return "Já tem uma análise rodando — te aviso quando terminar.";
      if (outcome === "skipped_cost_cap") return "Limite de custo de análise deste período atingido; renova no próximo mês.";
      if (outcome === "skipped_paused") return "O agente desta conta está pausado; retome nas configurações do site.";
      return "Não consegui iniciar a análise agora.";
    },
    {
      name: "trigger_analysis",
      description:
        "Dispara uma análise on-demand da conta ('analisa agora'). O resultado chega em seguida na conversa.",
      schema: z.object({}),
    },
  );

  // ── ESCRITA (resolução de pendente) — o push do cron/nudge foi o eco; referência
  //    inequívoca aplica direto, o LLM só chama com id claro (§8: ambíguo → pergunta).
  //    O apply-service re-checa fresco + guardrail antes de escrever (rede final).
  const approve = tool(
    async (input: { approvalIds: string[] }) => {
      let ok = 0;
      let skipped = 0;
      for (const id of input.approvalIds) {
        const appr = await deps.ports.approval.getById(id as ApprovalId);
        if (!appr || appr.orgId !== ctx.orgId || appr.status !== "pending") {
          skipped += 1;
          continue;
        }
        await deps.ports.scheduler.enqueue({
          queue: APPROVAL_APPLY_QUEUE,
          name: APPROVAL_APPLY_JOB,
          payload: { orgId: ctx.orgId, approvalId: id, notifyContactId: ctx.contactId },
        });
        ok += 1;
      }
      const tail = skipped > 0 ? ` (${skipped} já não estava(m) pendente(s).)` : "";
      return ok > 0
        ? `Tô aplicando ${ok} ação(ões) — te aviso o resultado de cada uma.${tail}`
        : `Nada pra aplicar${tail}`;
    },
    {
      name: "approve",
      description:
        "APROVA ações pendentes (por id, vindos de list_pending). Só chame com referência clara do usuário; se ambíguo, pergunte antes. O resultado de cada uma chega em seguida.",
      schema: z.object({ approvalIds: z.array(z.string()).min(1) }),
    },
  );

  const reject = tool(
    async (input: { approvalIds: string[] }) => {
      let ok = 0;
      let skipped = 0;
      for (const id of input.approvalIds) {
        const appr = await deps.ports.approval.getById(id as ApprovalId);
        if (!appr || appr.orgId !== ctx.orgId || appr.status !== "pending") {
          skipped += 1;
          continue;
        }
        await deps.ports.approval.resolve(id as ApprovalId, { status: "rejected" });
        ok += 1;
      }
      const tail = skipped > 0 ? ` (${skipped} já não estava(m) pendente(s).)` : "";
      return `Rejeitei ${ok} ação(ões).${tail}`;
    },
    {
      name: "reject",
      description:
        "REJEITA ações pendentes (por id, vindos de list_pending). Nada é aplicado na Meta. Só chame com referência clara.",
      schema: z.object({ approvalIds: z.array(z.string()).min(1) }),
    },
  );

  // ── ESCRITA LIVRE (5c): estas tools NÃO executam aqui — o roteador desvia pro nó
  //    `confirm` (eco+confirma) ANTES do ToolNode. São só a declaração p/ o LLM propor.
  //    A aplicação real acontece no nó `applyWrite` após o `confirm_write`.
  const writeSchema = {
    entityLevel: z.enum(["campaign", "adset", "ad"]),
    entityId: z.string().min(1),
    entityName: z.string().min(1).describe("nome legível da entidade (do get_campaign_analysis)"),
  };
  const proposeOnly = async () => "—"; // nunca chamado (roteado p/ confirm)

  const pauseEntity = tool(proposeOnly, {
    name: "pause_entity",
    description: "Propõe PAUSAR uma entidade (campanha/conjunto/anúncio). Requer eco+confirma antes de aplicar.",
    schema: z.object(writeSchema),
  });
  const resumeEntity = tool(proposeOnly, {
    name: "resume_entity",
    description: "Propõe REATIVAR uma entidade pausada. Requer eco+confirma.",
    schema: z.object(writeSchema),
  });
  const setStatus = tool(proposeOnly, {
    name: "set_status",
    description: "Propõe mudar o status de uma entidade. Requer eco+confirma.",
    schema: z.object({ ...writeSchema, status: z.enum(["active", "paused"]) }),
  });
  const adjustBudget = tool(proposeOnly, {
    name: "adjust_budget",
    description:
      "Propõe ajustar o budget diário: por % (mode increase/decrease + pct) OU valor absoluto (mode set + amountReais). Requer eco+confirma.",
    schema: z.object({
      ...writeSchema,
      mode: z.enum(["increase", "decrease", "set"]),
      pct: z.number().positive().optional().describe("magnitude % (só para increase/decrease)"),
      amountReais: z.number().positive().optional().describe("valor absoluto em reais (só para mode set)"),
    }),
  });

  // ── CONTROLE do eco+confirma (turno 2): o LLM classifica a intenção do usuário.
  //    A ação aplicada é a CONGELADA no state (não re-especifica nada). Roteadas p/ applyWrite.
  const confirmWrite = tool(proposeOnly, {
    name: "confirm_write",
    description: "Confirma a(s) ação(ões) pendente(s) que você ecoou — só quando o usuário disser sim claramente.",
    schema: z.object({}),
  });
  const cancelWrite = tool(proposeOnly, {
    name: "cancel_write",
    description: "Cancela a(s) ação(ões) pendente(s) — quando o usuário recusar.",
    schema: z.object({}),
  });

  // DESFAZER (5c-4): também é escrita → passa pelo mesmo eco+confirma (roteado p/ confirm).
  const revertAction = tool(proposeOnly, {
    name: "revert_action",
    description:
      "Propõe DESFAZER uma ação que você aplicou (use find_recent_actions p/ achar o id). Requer eco+confirma.",
    schema: z.object({
      toolCallId: z.string().min(1),
      label: z.string().min(1).describe("nome da entidade (de find_recent_actions)"),
      actionType: z.string().min(1).describe("tipo da ação original (de find_recent_actions)"),
    }),
  });

  // FOCO (5c-6): em org multi-conta, escolhe a conta do fio. Executa direto (baixo risco,
  // sem eco) e persiste em conversations.focused_account_id — o próximo turno opera nela.
  const setFocus = tool(
    async ({ name }: { name: string }) => {
      const rows = await deps.db
        .select({ id: adAccounts.id, name: adAccounts.name })
        .from(adAccounts)
        .where(and(eq(adAccounts.orgId, ctx.orgId), eq(adAccounts.status, "active"), ilike(adAccounts.name, `%${name}%`)));
      if (rows.length === 0) return `Não achei uma conta ativa com "${name}" no nome.`;
      if (rows.length > 1) return `Mais de uma conta casa "${name}": ${rows.map((r) => r.name).join(", ")}. Qual delas?`;
      const acc = rows[0]!;
      await deps.db
        .update(conversations)
        .set({ focusedAccountId: acc.id })
        .where(and(eq(conversations.id, ctx.conversationId), eq(conversations.orgId, ctx.orgId)));
      return `Ok, foquei na conta ${acc.name}. O que você quer fazer nela?`;
    },
    {
      name: "set_focus",
      description:
        "Escolhe a conta em foco desta conversa (org com várias contas). Ex: 'foca na Clínica X'. Depois disso, leitura e ações passam a ser dessa conta.",
      schema: z.object({ name: z.string().min(1) }),
    },
  );

  const writeTools = [pauseEntity, resumeEntity, setStatus, adjustBudget, revertAction, confirmWrite, cancelWrite];
  return [...readTools, triggerAnalysis, approve, reject, setFocus, ...writeTools].filter((t) => allow.has(t.name));
}

/** Constrói a `Action` neutra a partir de um tool_call de escrita livre do chat (5c). */
export function actionFromToolCall(name: string, args: Record<string, unknown>, id: string): Action | null {
  if (!WRITE_TOOL_NAMES.has(name)) return null;
  const level = args["entityLevel"] as EntityLevel;
  const entityId = String(args["entityId"] ?? "");
  const entityName = typeof args["entityName"] === "string" ? (args["entityName"] as string) : undefined;
  if (!level || !entityId) return null;

  const base = {
    id,
    type: name as ActionType,
    target: { level, id: entityId, ...(entityName ? { name: entityName } : {}) },
    source: "llm" as const,
    riskLevel: "medium" as const, // gate sempre confirma; risco real vem do guardrail
    reason: "solicitado no chat",
  };

  if (name === "set_status") {
    return { ...base, params: { [ACTION_PARAM_STATUS]: String(args["status"] ?? "") } };
  }
  if (name === "adjust_budget") {
    const mode = String(args["mode"] ?? "");
    if (mode === BUDGET_MODE_SET) {
      const reais = Number(args["amountReais"]);
      if (!Number.isFinite(reais)) return null;
      return { ...base, params: { [ACTION_PARAM_MODE]: mode, [ACTION_PARAM_AMOUNT_MINOR]: Math.round(reais * 100) } };
    }
    const pct = Number(args["pct"]);
    if (!Number.isFinite(pct)) return null;
    return { ...base, params: { [ACTION_PARAM_MODE]: mode, [ACTION_PARAM_PCT]: Math.abs(pct) } };
  }
  return { ...base, params: {} };
}

/**
 * Base com 1 agente em contexto: leitura + análise + resolução de pendentes + controle
 * do eco+confirma. As tools de ESCRITA LIVRE (pause/resume/set_status/adjust_budget)
 * entram por cima, filtradas por `allowedActions` do agente (montado em `turn.ts`).
 */
export const AGENT_TOOL_NAMES: ReadonlySet<string> = new Set([
  "get_account_status",
  "get_metrics",
  "get_campaign_analysis",
  "get_entity_detail",
  "compare_periods",
  "get_agent_config",
  "explain_recommendation",
  "list_recommendations",
  "list_pending",
  "trigger_analysis",
  "approve",
  "reject",
  "find_recent_actions",
  "revert_action",
  "confirm_write",
  "cancel_write",
  "set_focus",
]);

/**
 * Concierge (org multi-conta SEM foco): org-level (pendentes cross-conta) + set_focus
 * p/ escolher a conta e destravar leitura/escrita (5c-6).
 */
export const CONCIERGE_TOOL_NAMES: ReadonlySet<string> = new Set(["list_pending", "approve", "reject", "set_focus"]);

/**
 * Tools de ESCRITA LIVRE que exigem ECO+CONFIRMA antes de aplicar (gate, 5c). O roteador
 * as desvia pro nó `confirm`. `approve`/`reject` NÃO entram: o nudge/análise já foi o eco.
 * A allowlist real por-agente sai de `allowedActions` (guardrail) em `turn.ts`.
 */
export const WRITE_TOOL_NAMES: ReadonlySet<string> = new Set<string>([
  "pause_entity",
  "resume_entity",
  "set_status",
  "adjust_budget",
]);

/** Tool de DESFAZER — também passa pelo eco+confirma (roteada pro nó `confirm`, 5c-4). */
export const REVERT_TOOL_NAME = "revert_action";

/** Tools de controle do eco+confirma (turno 2) — roteadas pro nó `applyWrite`. */
export const CONTROL_WRITE_TOOL_NAMES: ReadonlySet<string> = new Set<string>(["confirm_write", "cancel_write"]);

/** Nome de tool de escrita ↔ tipo de ação (p/ filtrar a allowlist por `allowedActions`). */
export const WRITE_TOOL_TO_ACTION: ReadonlyMap<string, ActionType> = new Map([
  ["pause_entity", "pause_entity"],
  ["resume_entity", "resume_entity"],
  ["set_status", "set_status"],
  ["adjust_budget", "adjust_budget"],
]);
