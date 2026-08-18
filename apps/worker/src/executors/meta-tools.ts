// Executores de ESCRITA na Meta via AdsPlatformPort. Cada execução:
//  - resolve idempotencyKey (agent_tool_calls.idempotency_key) → nunca aplica 2x
//  - captura before_state (snapshot p/ rollback) retornado por mutate()
//  - registra o tool_call (args/result/before/risk) na auditoria
// A regra de negócio (eco+confirma, guardrail, autonomia) já rodou ANTES daqui.

import type { Action, MutationResult } from "@trafego/shared/types";
import type { AdAccountRef } from "@trafego/shared/ports";
import type { WorkerDeps } from "../composition.js";

export interface ExecuteActionInput {
  readonly runId: string;
  readonly account: AdAccountRef;
  readonly action: Action;
  /** chave idempotente estável (ex: `${runId}:${action.id}`). */
  readonly idempotencyKey: string;
}

export function makeMetaToolExecutor(deps: WorkerDeps) {
  const { ports, logger } = deps;

  /** Aplica uma ação de escrita (pause/resume/adjust_budget/set_status). */
  async function execute(input: ExecuteActionInput): Promise<MutationResult> {
    logger.debug({ runId: input.runId, action: input.action.type }, "meta-tool:execute");
    // TODO: checar agent_tool_calls por idempotencyKey — se já aplicado, retornar result gravado.
    // TODO: result = await ports.ads.mutate(input.account, input.action);
    //       (mutate já devolve before/after p/ rollback).
    // TODO: gravar agent_tool_calls(idempotency_key, risk, args, result, before_state) + audit_log.
    // TODO: registrar usage_events (ação aplicada) via MeteringPort.
    void ports;
    throw new Error("not implemented: meta-tool execute");
  }

  /** Leitura de apoio: estado atual da entidade (p/ montar eco/before_state). */
  async function readEntity(account: AdAccountRef, level: string, id: string): Promise<unknown> {
    logger.debug({ level, id }, "meta-tool:read");
    // TODO: ports.ads.listEntities(account, level) → find(id) (usar cache/governor do adapter).
    return null;
  }

  return { execute, readEntity };
}

export type MetaToolExecutor = ReturnType<typeof makeMetaToolExecutor>;
