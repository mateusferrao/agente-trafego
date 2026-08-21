// Catálogo de tools do agente conversacional (allowlist por turno).
// 5b-2.2: LEITURA (sobre nosso DB curado — read-data.ts) + `trigger_analysis`
// (dispara análise on-demand com push de volta na conversa). Nenhuma tool chama a
// Meta. Tools de ESCRITA (aprovar/rejeitar) entram na 5b-2.3.

import { and, desc, eq, ilike } from "drizzle-orm";
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { adAccounts, agents, conversations, playbookRules } from "@trafego/db";
import {
  ACTION_PARAM_AMOUNT_MINOR,
  ACTION_PARAM_MODE,
  ACTION_PARAM_PCT,
  ACTION_PARAM_STATUS,
  APPROVAL_APPLY_JOB,
  APPROVAL_APPLY_QUEUE,
  BUDGET_MODE_SET,
  CONVERSION_GOALS,
  type ActionType,
  type ApprovalId,
  type AutonomyLevel,
  type AutonomyPolicy,
  type CadenceSpec,
  type ConversionGoal,
  type EntityLevel,
} from "@trafego/shared";
import {
  describePlaybookRule,
  type AgentConfigPatch,
  type AgentConfigState,
  type AgentGoalsPatch,
} from "@trafego/core";
import type { Action } from "@trafego/shared/types";
import type { WorkerDeps } from "../../composition.js";
import { createRunDispatcher } from "../../modules/dispatch/run-dispatcher.js";
import { makeReadTools, type ReadToolContext } from "./read-data.js";
import type { PendingPlaybookOp } from "./state.js";

export interface ConversationToolContext extends ReadToolContext {
  /** thread da conversa (checkpointer) — alvo do push do "analisa agora". */
  readonly conversationId: string;
  /** org com >1 conta ativa (concierge/multi-conta) — o eco nomeia a conta (5c-6). */
  readonly multiAccount?: boolean;
  /** nome da conta em foco/contexto (exibição no eco, org multi-conta). */
  readonly accountName?: string;
  /** kill-switch da auto-config por chat ON (S2.3) — molda o system-prompt (chat × site). */
  readonly configViaChat?: boolean;
}

// ── Vocabulário das tools de config (sem string mágica; espelham os enums do site).
const AUTONOMY_LEVELS = ["notify", "suggest", "act_safe", "act_full"] as const satisfies readonly AutonomyLevel[];
const ACTION_TYPES = ["pause_entity", "resume_entity", "adjust_budget", "set_status"] as const satisfies readonly ActionType[];
const CADENCE_KINDS = ["daily", "twice_daily", "weekly", "raw"] as const;
// Playbook: MESMO shape do `playbookRuleInput` do site (apps/api). Não importável de um
// app; modelado igual aqui. CRUD de playbook é candidato a extração p/ shared (fast-follow).
const PLAYBOOK_SCOPES = ["campaign", "adset", "ad"] as const;
const PLAYBOOK_METRICS = ["cpa", "roas", "spend", "cpc", "cpm", "ctr", "frequency"] as const;
const PLAYBOOK_OPS = [">", "<", ">=", "<=", "=="] as const;
const PLAYBOOK_THEN_ACTIONS = ["pause_entity", "adjust_budget", "set_status"] as const;

/** Horas/dia default quando o campo do preset de cadência vier ausente. */
const DEFAULT_CADENCE_HOUR = 8;
const DEFAULT_CADENCE_SECOND_HOUR = 18;
const DEFAULT_CADENCE_WEEKDAY = 1; // segunda

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
      // nullable+optional: o structured-output exige que campo omissível seja nullable.
      pct: z.number().positive().nullable().optional().describe("magnitude % (só para increase/decrease)"),
      amountReais: z.number().positive().nullable().optional().describe("valor absoluto em reais (só para mode set)"),
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

  // ── CONFIG POR CHAT (S2.3–S2.6): proposeOnly (roteadas pro `confirm`). Config NÃO
  //    toca a Meta → ramo próprio no gate (sem guardrail/dry-run de ads). Eco+confirma
  //    sempre. Ligadas na allowlist só com o kill-switch `autoConfigViaChat` ON (turn.ts).
  const setGoal = tool(proposeOnly, {
    name: "set_goal",
    description:
      "Define a META de negócio do agente: CPA alvo (custo por resultado), ROAS alvo (retorno) e/ou a conversão que conta como resultado. Use null p/ limpar um campo. Requer eco+confirma.",
    schema: z.object({
      targetCPA: z.number().positive().nullable().optional().describe("CPA alvo em reais"),
      targetROAS: z.number().positive().nullable().optional().describe("ROAS alvo (múltiplo, ex: 3 = 3x)"),
      conversionGoal: z.enum(CONVERSION_GOALS).nullable().optional().describe("conversão de negócio"),
      customConversionId: z.string().nullable().optional().describe("id da conversão personalizada (se conversionGoal='custom')"),
    }),
  });
  const setAutonomy = tool(proposeOnly, {
    name: "set_autonomy",
    description:
      "Define a AUTONOMIA por origem: só avisa (notify), sugere e pede OK (suggest), age no seguro (act_safe) ou age sozinho (act_full). 'playbook' = regras determinísticas; 'llm' = análise por IA. Só troca as origens enviadas. Requer eco+confirma.",
    schema: z.object({
      playbook: z.enum(AUTONOMY_LEVELS).nullable().optional(),
      llm: z.enum(AUTONOMY_LEVELS).nullable().optional(),
    }),
  });
  const setGuardrail = tool(proposeOnly, {
    name: "set_guardrail",
    description:
      "Ajusta os GUARDRAILS (rede de segurança): limite de mudança de budget (%), máximo de entidades por dia, modo simulação (dryRun), botão de emergência (killSwitch), ações permitidas e teto de custo de IA. Só troca os campos enviados. Requer eco+confirma.",
    schema: z.object({
      maxBudgetChangePct: z.number().min(0).max(100).nullable().optional(),
      maxEntitiesPerDay: z.number().int().min(0).nullable().optional(),
      dryRun: z.boolean().nullable().optional(),
      killSwitch: z.boolean().nullable().optional(),
      allowedActions: z.array(z.enum(ACTION_TYPES)).nullable().optional(),
      llmCostCapUsd: z.number().min(0).nullable().optional(),
    }),
  });
  const setCadence = tool(proposeOnly, {
    name: "set_cadence",
    description:
      "Define a CADÊNCIA da análise automática: diária (daily), 2×/dia (twice_daily), semanal (weekly) ou cron avançado (raw). 'hour' e 'secondHour' são horas (0-23); 'weekday' é o dia (0=domingo..6=sábado). Requer eco+confirma.",
    schema: z.object({
      kind: z.enum(CADENCE_KINDS),
      hour: z.number().int().min(0).max(23).nullable().optional(),
      secondHour: z.number().int().min(0).max(23).nullable().optional().describe("2ª hora (só twice_daily)"),
      weekday: z.number().int().min(0).max(6).nullable().optional().describe("dia da semana (só weekly)"),
      cron: z.string().nullable().optional().describe("expressão cron (só raw)"),
    }),
  });
  const reseedArchetype = tool(proposeOnly, {
    name: RESEED_TOOL_NAME,
    description:
      "Re-semeia um ARQUÉTIPO (preset): reseta o comportamento (persona/tom/metodologia/autonomia) pros padrões do arquétipo, preservando meta+contexto+orientações. Requer eco+confirma.",
    schema: z.object({ archetype: z.string().min(1).describe("chave do arquétipo (ex: conservador, otimizador, guardiao_lancamento)") }),
  });

  // ── IDENTIDADE POR CHAT (S2.6): persona/tom/metodologia. Texto vazio limpa (volta ao
  //    arquétipo). Reusa o fluxo de `update` do pendingConfigChange (é AgentConfigPatch).
  const setPersona = tool(proposeOnly, {
    name: "set_persona",
    description: "Define a PERSONA do agente (papel/postura em 1 linha). Texto vazio limpa (volta ao arquétipo). Requer eco+confirma.",
    schema: z.object({ text: z.string() }),
  });
  const setTone = tool(proposeOnly, {
    name: "set_tone",
    description: "Define o TOM da comunicação do agente. Texto vazio limpa (volta ao arquétipo). Requer eco+confirma.",
    schema: z.object({ text: z.string() }),
  });
  const setSystemPrompt = tool(proposeOnly, {
    name: "set_system_prompt",
    description:
      "Substitui a METODOLOGIA-base (system prompt) do agente. ATENÇÃO: isso substitui a metodologia do arquétipo. Texto vazio limpa (volta ao arquétipo). Requer eco+confirma.",
    schema: z.object({ text: z.string() }),
  });

  // ── PLAYBOOK POR CHAT (S2.5): regras determinísticas condição→ação. add/toggle/remove
  //    exigem eco+confirma (proposeOnly). list é leitura (executa direto, numera as regras).
  const addPlaybookRule = tool(proposeOnly, {
    name: "add_playbook_rule",
    description:
      "Cria uma REGRA do playbook: SE [métrica op valor] (com gasto mínimo opcional) ENTÃO [ação], num nível. Ex: pausar anúncio com custo por resultado acima de R$ 30. Requer eco+confirma.",
    schema: z.object({
      scope: z.enum(PLAYBOOK_SCOPES),
      metric: z.enum(PLAYBOOK_METRICS),
      op: z.enum(PLAYBOOK_OPS),
      value: z.number(),
      minSpend: z.number().min(0).nullable().optional().describe("só entidades com gasto ≥ este valor"),
      thenAction: z.enum(PLAYBOOK_THEN_ACTIONS),
      budgetChangePct: z.number().nullable().optional().describe("variação de budget em % (só adjust_budget; negativo reduz)"),
      status: z.enum(["active", "paused"]).nullable().optional().describe("status alvo (só set_status)"),
    }),
  });
  const togglePlaybookRule = tool(proposeOnly, {
    name: "toggle_playbook_rule",
    description: "Liga ou desliga uma REGRA existente do playbook (por id, vindo de list_playbook_rules). Requer eco+confirma.",
    schema: z.object({ ruleId: z.string().min(1), enabled: z.boolean() }),
  });
  const removePlaybookRule = tool(proposeOnly, {
    name: "remove_playbook_rule",
    description: "Remove uma REGRA do playbook (por id, vindo de list_playbook_rules). Requer eco+confirma.",
    schema: z.object({ ruleId: z.string().min(1) }),
  });
  const listPlaybookRules = tool(
    async () => {
      const rows = await deps.db
        .select()
        .from(playbookRules)
        .where(and(eq(playbookRules.agentId, ctx.agentId), eq(playbookRules.orgId, ctx.orgId)))
        .orderBy(desc(playbookRules.priority));
      if (rows.length === 0) return "Você não tem nenhuma regra de playbook configurada nesta conta.";
      const lines = rows.map((r, i) => `${i + 1}. [id: ${r.id}] ${describePlaybookRule(ruleRowToDescriptor(r))}${r.enabled ? "" : " (desligada)"}`);
      return `Regras de playbook desta conta:\n${lines.join("\n")}`;
    },
    {
      name: "list_playbook_rules",
      description: "Lista as regras de playbook da conta (numeradas, com o id de cada uma). Use antes de ligar/desligar/remover.",
      schema: z.object({}),
    },
  );

  // AUTOCONHECIMENTO (S2.7): descreve, com honestidade, TUDO o que o agente faz NESTE
  // contexto — separando "o que faço quando você pede" (sempre com confirmação) do "o
  // que faço sozinho nas análises" (depende da autonomia). Reflete o estado real (allow
  // + allowedActions + kill-switch), nunca overpromete. Concierge = visão geral.
  const describeCapabilities = tool(
    async () => {
      if (!ctx.agentId) {
        return [
          "Sou seu gestor de tráfego aqui no WhatsApp. Sem uma conta em foco, posso:",
          "• ver e resolver pendências de aprovação (de todas as suas contas);",
          '• focar numa conta (ex: "foca na Clínica X") pra ler, analisar e agir nela.',
          "Me diz em qual conta você quer trabalhar.",
        ].join("\n");
      }
      const parts: string[] = ["Aqui no WhatsApp eu consigo:"];
      parts.push("📊 Ler: status da conta, métricas, análise por campanha, recomendações, desperdício, comparar períodos e ver pendências.");
      const writeVerbs = [...WRITE_TOOL_NAMES].filter((n) => allow.has(n)).map((n) => WRITE_VERB_PT[n]).filter(Boolean);
      if (writeVerbs.length > 0) {
        parts.push(`✏️ Mexer nas campanhas (sempre te mostro e confirmo antes): ${writeVerbs.join(", ")}. Também dá pra desfazer o que apliquei.`);
      } else {
        parts.push("✏️ Mexer nas campanhas: hoje está desligado nos guardrails — dá pra liberar nas configurações.");
      }
      parts.push("⚡ Analisar agora e aprovar/rejeitar ações pendentes.");
      if (ctx.configViaChat) {
        parts.push("⚙️ Mudar a config do agente conversando (sempre com sua confirmação): meta, autonomia, guardrails, cadência, arquétipo, playbook e identidade.");
      } else {
        parts.push("⚙️ Config do agente: por aqui está desligada — mudanças de config são pelo site.");
      }
      const [row] = await deps.db
        .select({ autonomyPolicy: agents.autonomyPolicy })
        .from(agents)
        .where(and(eq(agents.id, ctx.agentId), eq(agents.orgId, ctx.orgId)))
        .limit(1);
      const pol = row?.autonomyPolicy as AutonomyPolicy | undefined;
      if (pol?.bySource) {
        const lbl = (l: string) => AUTONOMY_LABEL_CHAT[l] ?? l;
        parts.push(`🤖 Nas análises automáticas (sem você pedir): com o playbook eu ${lbl(pol.bySource.playbook)}; com sugestões de IA eu ${lbl(pol.bySource.llm)}.`);
      }
      parts.push("🚧 Ainda não: criar campanhas do zero (em breve) nem editar criativos.");
      parts.push("É só pedir. 🙂");
      return parts.join("\n");
    },
    {
      name: "describe_capabilities",
      description:
        "Explica ao usuário tudo o que você consegue fazer nesta conversa (ler, mexer nas campanhas, analisar, aprovar, configurar), refletindo o que está habilitado agora. Use quando ele perguntar o que você faz / como ajuda / o que consegue fazer.",
      schema: z.object({}),
    },
  );

  const configTools = [setGoal, setAutonomy, setGuardrail, setCadence, reseedArchetype, setPersona, setTone, setSystemPrompt];
  const playbookTools = [addPlaybookRule, togglePlaybookRule, removePlaybookRule, listPlaybookRules];

  const writeTools = [pauseEntity, resumeEntity, setStatus, adjustBudget, revertAction, confirmWrite, cancelWrite];
  return [...readTools, triggerAnalysis, approve, reject, setFocus, describeCapabilities, ...writeTools, ...configTools, ...playbookTools].filter(
    (t) => allow.has(t.name),
  );
}

/** Rótulo de gente do nível de autonomia (1ª pessoa, p/ o describe_capabilities). */
const AUTONOMY_LABEL_CHAT: Readonly<Record<string, string>> = {
  notify: "só te aviso",
  suggest: "sugiro e peço seu OK",
  act_safe: "ajo no seguro",
  act_full: "ajo sozinho",
};

/** Verbo de gente por tool de escrita Meta (p/ listar o que está habilitado). */
const WRITE_VERB_PT: Readonly<Record<string, string>> = {
  pause_entity: "pausar campanhas/conjuntos/anúncios",
  resume_entity: "reativar o que está pausado",
  set_status: "mudar o status de entidades",
  adjust_budget: "ajustar o budget",
};

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
      // == null cobre o `null` que o structured-output manda no campo não usado do outro modo.
      if (args["amountReais"] == null) return null;
      const reais = Number(args["amountReais"]);
      if (!Number.isFinite(reais)) return null;
      return { ...base, params: { [ACTION_PARAM_MODE]: mode, [ACTION_PARAM_AMOUNT_MINOR]: Math.round(reais * 100) } };
    }
    if (args["pct"] == null) return null;
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
  "describe_capabilities",
]);

/**
 * Concierge (org multi-conta SEM foco): org-level (pendentes cross-conta) + set_focus
 * p/ escolher a conta e destravar leitura/escrita (5c-6) + autoconhecimento (S2.7).
 */
export const CONCIERGE_TOOL_NAMES: ReadonlySet<string> = new Set([
  "list_pending",
  "approve",
  "reject",
  "set_focus",
  "describe_capabilities",
]);

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

// ─── CONFIG POR CHAT (S2.3–S2.6): nomes + tradução tool_call → patch/op ──────────

/** Tools de config que viram um `update` de `AgentConfigPatch` (meta/autonomia/guardrail/cadência). */
export const CONFIG_TOOL_NAMES: ReadonlySet<string> = new Set(["set_goal", "set_autonomy", "set_guardrail", "set_cadence"]);
/** Tools de IDENTIDADE (S2.6) — também um `update` de patch (persona/tom/metodologia). */
export const IDENTITY_TOOL_NAMES: ReadonlySet<string> = new Set(["set_persona", "set_tone", "set_system_prompt"]);
/** Tool de re-seed de arquétipo (pendência kind="reseed"). */
export const RESEED_TOOL_NAME = "reseed_archetype";
/** Tools de escrita de playbook (pendência kind="playbook", eco+confirma). */
export const PLAYBOOK_WRITE_TOOL_NAMES: ReadonlySet<string> = new Set([
  "add_playbook_rule",
  "toggle_playbook_rule",
  "remove_playbook_rule",
]);
/** Tool de leitura do playbook (executa direto, numera as regras). */
export const PLAYBOOK_READ_TOOL_NAME = "list_playbook_rules";

/** Tools que produzem um `update` de config (set_* de config + identidade). */
export const CONFIG_UPDATE_TOOL_NAMES: ReadonlySet<string> = new Set([...CONFIG_TOOL_NAMES, ...IDENTITY_TOOL_NAMES]);

/**
 * TODAS as tools de config-por-chat (S2.3–S2.6): entram na allowlist só com o kill-switch
 * `autoConfigViaChat` ligado (turn.ts). NÃO passam por `allowedActions` (isso é só escrita Meta).
 */
export const CONFIG_CHAT_TOOL_NAMES: ReadonlySet<string> = new Set([
  ...CONFIG_TOOL_NAMES,
  ...IDENTITY_TOOL_NAMES,
  RESEED_TOOL_NAME,
  ...PLAYBOOK_WRITE_TOOL_NAMES,
  PLAYBOOK_READ_TOOL_NAME,
]);

/** É uma tool de config roteada pro gate de eco+confirma (update/reseed/playbook write)? */
export function isConfirmableConfigTool(name: string): boolean {
  return CONFIG_UPDATE_TOOL_NAMES.has(name) || name === RESEED_TOOL_NAME || PLAYBOOK_WRITE_TOOL_NAMES.has(name);
}

/** `null`/`undefined` = mantém; `null` explícito no arg = limpa (undefined em goals). */
function mergeNullableGoal<T>(argVal: T | null | undefined, curVal: T | undefined): T | undefined {
  if (argVal === undefined) return curVal;
  return argVal === null ? undefined : argVal;
}

/** Traduz um tool_call de `update` (set_* de config/identidade) → `AgentConfigPatch`.
 *  Precisa do estado atual p/ os MERGES (só sobrepõe os campos enviados). Não-update → null. */
export function configPatchFromToolCall(
  name: string,
  args: Record<string, unknown>,
  current: AgentConfigState,
): AgentConfigPatch | null {
  switch (name) {
    case "set_goal": {
      const g = current.goals;
      const goals: AgentGoalsPatch = {
        targetCPA: mergeNullableGoal(args["targetCPA"] as number | null | undefined, g.targetCPA),
        targetROAS: mergeNullableGoal(args["targetROAS"] as number | null | undefined, g.targetROAS),
        conversionGoal: mergeNullableGoal(args["conversionGoal"] as ConversionGoal | null | undefined, g.conversionGoal),
        customConversionId: mergeNullableGoal(args["customConversionId"] as string | null | undefined, g.customConversionId),
      };
      return { goals };
    }
    case "set_autonomy": {
      const cur = current.autonomyPolicy;
      const playbook = (args["playbook"] as AutonomyLevel | null | undefined) ?? cur.bySource.playbook;
      const llm = (args["llm"] as AutonomyLevel | null | undefined) ?? cur.bySource.llm;
      const next: AutonomyPolicy = { ...cur, bySource: { playbook, llm } };
      return { autonomyPolicy: next };
    }
    case "set_guardrail": {
      const g = current.guardrails;
      const llmCostCapArg = args["llmCostCapUsd"] as number | null | undefined;
      return {
        guardrails: {
          maxBudgetChangePct: (args["maxBudgetChangePct"] as number | null | undefined) ?? g.maxBudgetChangePct,
          maxEntitiesPerDay: (args["maxEntitiesPerDay"] as number | null | undefined) ?? g.maxEntitiesPerDay,
          allowedActions: (args["allowedActions"] as ActionType[] | null | undefined) ?? g.allowedActions,
          dryRun: (args["dryRun"] as boolean | null | undefined) ?? g.dryRun,
          killSwitch: (args["killSwitch"] as boolean | null | undefined) ?? g.killSwitch,
          llmCostCapUsd: llmCostCapArg === undefined ? g.llmCostCapUsd : (llmCostCapArg === null ? undefined : llmCostCapArg),
        },
      };
    }
    case "set_cadence": {
      const spec = cadenceFromToolCall(args);
      // raw sem cron → não muda a cadência (patch vazio de cadência).
      return spec === undefined ? {} : { cadence: spec };
    }
    case "set_persona":
      return { persona: String(args["text"] ?? "") };
    case "set_tone":
      return { tone: String(args["text"] ?? "") };
    case "set_system_prompt":
      return { systemPrompt: String(args["text"] ?? "") };
    default:
      return null;
  }
}

/** Traduz o tool_call de `set_cadence` → `CadenceSpec` (ou undefined se raw sem cron). */
function cadenceFromToolCall(args: Record<string, unknown>): CadenceSpec | undefined {
  const kind = String(args["kind"] ?? "");
  const hour = numOr(args["hour"], DEFAULT_CADENCE_HOUR);
  switch (kind) {
    case "daily":
      return { kind: "daily", hour };
    case "twice_daily":
      return { kind: "twice_daily", hours: [hour, numOr(args["secondHour"], DEFAULT_CADENCE_SECOND_HOUR)] };
    case "weekly":
      return { kind: "weekly", weekday: numOr(args["weekday"], DEFAULT_CADENCE_WEEKDAY), hour };
    case "raw": {
      const cron = args["cron"];
      return typeof cron === "string" && cron.length > 0 ? { kind: "raw", cron } : undefined;
    }
    default:
      return undefined;
  }
}

/** Número finito do arg, ou o default (cobre null/undefined/NaN do structured-output). */
function numOr(v: unknown, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/** Descritor neutro (p/ o eco) a partir do tool_call de `add_playbook_rule`. */
export function playbookDescriptorFromAdd(args: Record<string, unknown>): PlaybookAddInput {
  return {
    scope: String(args["scope"] ?? "") as PlaybookAddInput["scope"],
    metric: String(args["metric"] ?? ""),
    op: String(args["op"] ?? ""),
    value: Number(args["value"] ?? 0),
    minSpend: args["minSpend"] == null ? null : Number(args["minSpend"]),
    thenAction: String(args["thenAction"] ?? "") as PlaybookAddInput["thenAction"],
    budgetChangePct: args["budgetChangePct"] == null ? null : Number(args["budgetChangePct"]),
    status: (args["status"] as string | null | undefined) ?? null,
  };
}

/** Shape validado de uma regra a inserir (do tool_call `add_playbook_rule`). */
export interface PlaybookAddInput {
  readonly scope: "campaign" | "adset" | "ad";
  readonly metric: string;
  readonly op: string;
  readonly value: number;
  readonly minSpend: number | null;
  readonly thenAction: "pause_entity" | "adjust_budget" | "set_status";
  readonly budgetChangePct: number | null;
  readonly status: string | null;
}

/** Constrói a `PendingPlaybookOp` congelável a partir de um tool_call de playbook. Inválido → null. */
export function playbookOpFromToolCall(name: string, args: Record<string, unknown>): PendingPlaybookOp | null {
  if (name === "add_playbook_rule") {
    const a = playbookDescriptorFromAdd(args);
    if (!a.scope || !a.metric || !a.op || !a.thenAction) return null;
    if (a.thenAction === "adjust_budget" && a.budgetChangePct == null) return null;
    if (a.thenAction === "set_status" && !a.status) return null;
    const then: { type: string } & Record<string, unknown> =
      a.thenAction === "adjust_budget"
        ? { type: a.thenAction, budgetChangePct: a.budgetChangePct }
        : a.thenAction === "set_status"
          ? { type: a.thenAction, status: a.status }
          : { type: a.thenAction };
    return {
      kind: "add",
      rule: {
        scope: a.scope,
        metric: a.metric,
        op: a.op,
        value: a.value,
        ...(a.minSpend != null ? { minSpend: a.minSpend } : {}),
        then,
      },
    };
  }
  if (name === "toggle_playbook_rule") {
    const ruleId = String(args["ruleId"] ?? "");
    if (!ruleId) return null;
    return { kind: "toggle", ruleId, enabled: Boolean(args["enabled"]) };
  }
  if (name === "remove_playbook_rule") {
    const ruleId = String(args["ruleId"] ?? "");
    if (!ruleId) return null;
    return { kind: "remove", ruleId };
  }
  return null;
}

/** Linha de `playbook_rules` → descritor neutro (p/ `describePlaybookRule`). */
export function ruleRowToDescriptor(r: {
  scope: string;
  whenJson: { metric: string | number; op: string; value: number; minSpend?: number };
  thenJson: { type: string } & Record<string, unknown>;
}): PlaybookRuleDescriptorInput {
  return {
    scope: r.scope,
    metric: String(r.whenJson.metric),
    op: r.whenJson.op,
    value: r.whenJson.value,
    minSpend: r.whenJson.minSpend ?? null,
    thenType: r.thenJson.type,
    budgetChangePct: typeof r.thenJson["budgetChangePct"] === "number" ? (r.thenJson["budgetChangePct"] as number) : null,
    status: typeof r.thenJson["status"] === "string" ? (r.thenJson["status"] as string) : null,
  };
}

/** Espelha o `PlaybookRuleDescriptor` do core (evita import de tipo só p/ o cast). */
export interface PlaybookRuleDescriptorInput {
  readonly scope: string;
  readonly metric: string;
  readonly op: string;
  readonly value: number;
  readonly minSpend: number | null;
  readonly thenType: string;
  readonly budgetChangePct: number | null;
  readonly status: string | null;
}

/** Descritor neutro da regra congelada em `PendingPlaybookOp.rule` (p/ o eco). */
export function pendingRuleToDescriptor(rule: NonNullable<PendingPlaybookOp["rule"]>): PlaybookRuleDescriptorInput {
  return {
    scope: rule.scope,
    metric: rule.metric,
    op: rule.op,
    value: rule.value,
    minSpend: rule.minSpend ?? null,
    thenType: rule.then.type,
    budgetChangePct: typeof rule.then["budgetChangePct"] === "number" ? (rule.then["budgetChangePct"] as number) : null,
    status: typeof rule.then["status"] === "string" ? (rule.then["status"] as string) : null,
  };
}
