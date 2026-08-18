// Catálogo de tools do agente conversacional (allowlist por agente).
// Toda tool de ESCRITA passa por: guardrail + eco concreto + confirmação humana
// antes de executar (nunca auto-aplica no chat — CLAUDE §8). Tools de LEITURA
// (status, análise) executam direto.
//
// A allowlist real vem de agent_tool_bindings (catálogo-DB agent_tool_definitions):
// só as tools ligadas ao agente e permitidas pelo entitlement entram aqui.

import { tool } from "@langchain/core/tools";
import { z } from "zod";
import type { WorkerDeps } from "../../composition.js";

export interface ConversationToolContext {
  readonly orgId: string;
  readonly agentId: string;
  readonly adAccountId: string;
  readonly contactId: string;
}

/**
 * Monta as tools disponíveis para um turno, filtradas pela allowlist do agente.
 * `allow` = tool_keys ligadas (agent_tool_bindings).
 */
export function makeConversationTools(
  deps: WorkerDeps,
  ctx: ConversationToolContext,
  allow: ReadonlySet<string>,
) {
  const { logger } = deps;

  // ── LEITURA: seguro executar direto ──────────────────────────────────
  const getAccountStatus = tool(
    async () => {
      logger.debug({ agentId: ctx.agentId }, "tool:get_account_status");
      // TODO: ler último agent_run + insights_snapshots resumidos (read-only).
      return "TODO: status da conta";
    },
    {
      name: "get_account_status",
      description: "Retorna status atual da conta: último run, gasto, alertas.",
      schema: z.object({}),
    },
  );

  const triggerAnalysis = tool(
    async () => {
      logger.debug({ agentId: ctx.agentId }, "tool:trigger_analysis");
      // TODO: deps.ports.scheduler.enqueue({ queue:'agent-runs', name:'analysis', payload:{ trigger:'on_demand', ... } }).
      return "TODO: análise on-demand enfileirada";
    },
    {
      name: "trigger_analysis",
      description: "Dispara uma análise on-demand da conta ('analisa agora').",
      schema: z.object({}),
    },
  );

  // ── ESCRITA: exige eco+confirma. A tool NÃO executa a mutação; ela apenas
  //    PROPÕE (gera o eco). A confirmação humana no próximo turno libera a
  //    execução real via executors/meta-tools. ────────────────────────────
  const proposePause = tool(
    async (input: { entityLevel: string; entityId: string }) => {
      logger.debug({ agentId: ctx.agentId, input }, "tool:propose_pause");
      // TODO: montar eco concreto ("vou pausar o ad X que gastou R$Y sem venda") +
      //       validar guardrail antes de propor. Retorna eco p/ confirmação.
      return `ECHO_CONFIRM: pausar ${input.entityLevel} ${input.entityId}. Confirma?`;
    },
    {
      name: "propose_pause",
      description:
        "PROPÕE pausar uma entidade (não executa). Sempre gera eco concreto p/ confirmação humana.",
      schema: z.object({
        entityLevel: z.enum(["campaign", "adset", "ad"]),
        entityId: z.string(),
      }),
    },
  );

  const proposeAdjustBudget = tool(
    async (input: { entityLevel: string; entityId: string; mode: string; pct: number }) => {
      logger.debug({ agentId: ctx.agentId, input }, "tool:propose_adjust_budget");
      // TODO: eco concreto + guardrail (maxBudgetChangePct). Não executa aqui.
      return `ECHO_CONFIRM: ${input.mode} budget de ${input.entityId} em ${input.pct}%. Confirma?`;
    },
    {
      name: "propose_adjust_budget",
      description:
        "PROPÕE ajustar budget (não executa). Sempre gera eco concreto p/ confirmação humana.",
      schema: z.object({
        entityLevel: z.enum(["campaign", "adset", "ad"]),
        entityId: z.string(),
        mode: z.enum(["increase", "decrease", "set"]),
        pct: z.number(),
      }),
    },
  );

  const all = [getAccountStatus, triggerAnalysis, proposePause, proposeAdjustBudget];
  // aplica allowlist (agent_tool_bindings)
  return all.filter((t) => allow.has(t.name));
}

/** Nomes de tools que efetuam ESCRITA (exigem eco+confirma antes de executar). */
export const WRITE_TOOL_NAMES: ReadonlySet<string> = new Set([
  "propose_pause",
  "propose_adjust_budget",
]);
