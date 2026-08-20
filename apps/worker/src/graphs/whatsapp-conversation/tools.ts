// Catálogo de tools do agente conversacional (allowlist por turno).
// 5b-2.2: LEITURA (sobre nosso DB curado — read-data.ts) + `trigger_analysis`
// (dispara análise on-demand com push de volta na conversa). Nenhuma tool chama a
// Meta. Tools de ESCRITA (aprovar/rejeitar) entram na 5b-2.3.

import { tool } from "@langchain/core/tools";
import { z } from "zod";
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

  return [...readTools, triggerAnalysis].filter((t) => allow.has(t.name));
}

/** Nomes das tools de LEITURA/comando disponíveis na 5b-2.2 (não-escrita). */
export const READ_TOOL_NAMES: ReadonlySet<string> = new Set([
  "get_account_status",
  "get_metrics",
  "get_campaign_analysis",
  "list_recommendations",
  "list_pending",
  "trigger_analysis",
]);

/** Tools org-level (concierge multi-conta — não precisam de conta em contexto). */
export const CONCIERGE_TOOL_NAMES: ReadonlySet<string> = new Set(["list_pending"]);

/** Tools que efetuam ESCRITA (exigem eco+confirma). Preenchido na 5b-2.3. */
export const WRITE_TOOL_NAMES: ReadonlySet<string> = new Set<string>();
