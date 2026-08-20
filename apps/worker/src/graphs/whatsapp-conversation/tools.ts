// Catálogo de tools do agente conversacional (allowlist por turno).
// 5b-2.2: LEITURA (sobre nosso DB curado — read-data.ts) + `trigger_analysis`
// (dispara análise on-demand com push de volta na conversa). Nenhuma tool chama a
// Meta. Tools de ESCRITA (aprovar/rejeitar) entram na 5b-2.3.

import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { APPROVAL_APPLY_JOB, APPROVAL_APPLY_QUEUE, type ApprovalId } from "@trafego/shared";
import type { WorkerDeps } from "../../composition.js";
import { createRunDispatcher } from "../../modules/dispatch/run-dispatcher.js";
import { makeReadTools, type ReadToolContext } from "./read-data.js";

export interface ConversationToolContext extends ReadToolContext {
  /** thread da conversa (checkpointer) — alvo do push do "analisa agora". */
  readonly conversationId: string;
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

  return [...readTools, triggerAnalysis, approve, reject].filter((t) => allow.has(t.name));
}

/** Allowlist com 1 agente em contexto: leitura + análise + resolução de pendentes. */
export const AGENT_TOOL_NAMES: ReadonlySet<string> = new Set([
  "get_account_status",
  "get_metrics",
  "get_campaign_analysis",
  "list_recommendations",
  "list_pending",
  "trigger_analysis",
  "approve",
  "reject",
]);

/** Concierge (org multi-conta): só org-level — ver e resolver pendentes cross-conta. */
export const CONCIERGE_TOOL_NAMES: ReadonlySet<string> = new Set(["list_pending", "approve", "reject"]);

/**
 * Tools que exigem ECO+CONFIRMA antes de executar (gate). `approve`/`reject` NÃO
 * entram: o nudge/análise já foi o eco e a referência inequívoca aplica direto
 * (§8 — ambiguidade o LLM resolve perguntando). Escrita LIVRE do zero = 5c.
 */
export const WRITE_TOOL_NAMES: ReadonlySet<string> = new Set<string>();
