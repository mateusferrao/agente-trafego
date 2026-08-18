// Executores de CONTROLE (não mutam a Meta): disparar análise on-demand e
// consultar status. Usados pelas tools do grafo conversacional e por comandos
// on-demand do webhook.

import type { WorkerDeps } from "../composition.js";

export interface TriggerAnalysisInput {
  readonly orgId: string;
  readonly agentId: string;
  readonly adAccountId: string;
  readonly contactId?: string;
}

export interface AccountStatus {
  readonly adAccountId: string;
  readonly lastRunAt?: string;
  readonly lastRunStatus?: string;
  readonly tokenStatus?: string;
  // TODO: gasto recente, alertas abertos, aprovações pendentes.
}

export function makeControlToolExecutor(deps: WorkerDeps) {
  const { ports, logger } = deps;

  /** Enfileira uma análise on-demand (Grafo A) na fila agent-runs. */
  async function triggerAnalysis(input: TriggerAnalysisInput): Promise<{ enqueued: boolean }> {
    logger.debug({ agentId: input.agentId }, "control-tool:trigger_analysis");
    // TODO: ports.scheduler.enqueue({ queue:'agent-runs', name:'analysis',
    //        payload:{ trigger:'on_demand', ...input }, idempotencyKey });
    void ports;
    return { enqueued: false };
  }

  /** Lê o status atual da conta/agente (read-only). */
  async function getStatus(adAccountId: string): Promise<AccountStatus> {
    logger.debug({ adAccountId }, "control-tool:get_status");
    // TODO: consultar db (agent_runs, ad_accounts.token_status, approvals pendentes).
    return { adAccountId };
  }

  return { triggerAnalysis, getStatus };
}

export type ControlToolExecutor = ReturnType<typeof makeControlToolExecutor>;
