import type { Action } from "@trafego/shared/types";
import type { AdAccountRef, MutationResult } from "@trafego/shared/ports";
import type { MetaGraphClient } from "./client.js";

/**
 * Mutações na Meta: pause/resume/adjust_budget/set_status.
 *
 * Idempotência (§8): o adapter lê o estado atual (`before`) antes de escrever e
 * evita reaplicar quando o alvo já está no estado desejado. A casca ainda guarda
 * `idempotency_key` em `agent_tool_calls`; aqui garantimos before/after p/ rollback.
 */
export class MetaMutationsService {
  private readonly client: MetaGraphClient;

  constructor(client: MetaGraphClient) {
    this.client = client;
  }

  /** Aplica a ação e retorna before/after (rollback). Roteia por action.type. */
  mutate(account: AdAccountRef, action: Action): Promise<MutationResult> {
    // TODO: switch(action.type) → pauseEntity/resumeEntity/adjustBudget/setStatus.
    throw new Error("not implemented");
  }

  /** Lê o estado atual da entidade (status + budgets) p/ before-image. */
  readEntityState(
    account: AdAccountRef,
    level: Action["target"]["level"],
    entityId: string,
  ): Promise<Readonly<Record<string, unknown>>> {
    // TODO: GET {entity_id}?fields=status,effective_status,daily_budget,lifetime_budget.
    throw new Error("not implemented");
  }

  /** POST status=PAUSED na entidade. */
  pauseEntity(account: AdAccountRef, action: Action): Promise<MutationResult> {
    // TODO: idempotente — se já PAUSED, retorna before==after sem escrever.
    throw new Error("not implemented");
  }

  /** POST status=ACTIVE na entidade. */
  resumeEntity(account: AdAccountRef, action: Action): Promise<MutationResult> {
    // TODO: idempotente — se já ACTIVE, no-op.
    throw new Error("not implemented");
  }

  /** Ajusta budget (increase/decrease/set por pct ou valor absoluto). */
  adjustBudget(account: AdAccountRef, action: Action): Promise<MutationResult> {
    // TODO: ler budget atual, computar novo (params.mode/pct), POST daily/lifetime_budget.
    throw new Error("not implemented");
  }

  /** Define um status arbitrário (set_status). */
  setStatus(account: AdAccountRef, action: Action): Promise<MutationResult> {
    // TODO: mapear params.status → campo status da Graph.
    throw new Error("not implemented");
  }
}
