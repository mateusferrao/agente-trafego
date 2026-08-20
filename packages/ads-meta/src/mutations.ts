import type { Action } from "@trafego/shared/types";
import type { AdAccountRef, MutateOptions, MutationResult } from "@trafego/shared/ports";
import type { MetaGraphClient } from "./client.js";

/**
 * Mutações na Meta: pause/resume/adjust_budget/set_status.
 *
 * Idempotência (§8): lê o estado atual (`before`) antes de escrever e evita reaplicar
 * quando o alvo já está no estado desejado (before==after, sem POST). A casca ainda
 * guarda `idempotency_key` em `agent_tool_calls`; aqui garantimos before/after p/ rollback.
 * O budget é tratado em **unidade mínima** (centavos), como a Graph reporta/aceita.
 */

const STATUS_ACTIVE = "ACTIVE";
const STATUS_PAUSED = "PAUSED";
/** Piso de segurança de budget (unidade mínima) — Meta rejeita valores muito baixos. */
const MIN_BUDGET_MINOR = 100;

type EntityState = Record<string, unknown>;

/** Campos lidos p/ before-image (status + budgets). */
const STATE_FIELDS = "status,effective_status,daily_budget,lifetime_budget";

/** Mudança computada: campos a escrever + se o alvo já está no estado desejado. */
interface Change {
  readonly params: Readonly<Record<string, string>>;
  readonly alreadyThere: boolean;
}

export class MetaMutationsService {
  private readonly client: MetaGraphClient;

  constructor(client: MetaGraphClient) {
    this.client = client;
  }

  /** Aplica a ação e retorna before/after (rollback). Idempotente por leitura.
   *  `dryRun` → lê + computa o after, mas NÃO escreve (ensaio). */
  async mutate(account: AdAccountRef, action: Action, opts?: MutateOptions): Promise<MutationResult> {
    const before = await this.readEntityState(account, action.target.id);
    const change = computeChange(action, before);
    // after = intenção aplicada sobre o before (evita 2º GET; o undo restaura o before).
    const after: EntityState = change.alreadyThere ? before : { ...before, ...change.params };
    if (opts?.dryRun || change.alreadyThere) return { action, before, after };
    await this.writeFields(account, action.target.id, change.params);
    return { action, before, after };
  }

  /** Lê o estado atual da entidade (status + budgets) p/ before-image. */
  async readEntityState(account: AdAccountRef, entityId: string): Promise<EntityState> {
    const res = await this.client.request<EntityState>({
      method: "GET",
      path: entityId,
      accessToken: account.accessToken,
      params: { fields: STATE_FIELDS },
    });
    return res.data;
  }

  /** POST dos campos na entidade (status e/ou budget). */
  private async writeFields(
    account: AdAccountRef,
    entityId: string,
    params: Readonly<Record<string, string>>,
  ): Promise<void> {
    await this.client.request({ method: "POST", path: entityId, accessToken: account.accessToken, params });
  }
}

/** Computa os campos a escrever + idempotência, por tipo de ação. PURO. */
function computeChange(action: Action, before: EntityState): Change {
  switch (action.type) {
    case "pause_entity":
      return statusChange(before, STATUS_PAUSED);
    case "resume_entity":
      return statusChange(before, STATUS_ACTIVE);
    case "set_status":
      return statusChange(before, String(action.params["status"]).toUpperCase());
    case "adjust_budget":
      return budgetChange(action, before);
    default:
      throw new Error(`mutação não suportada: ${action.type}`);
  }
}

function statusChange(before: EntityState, target: string): Change {
  return { params: { status: target }, alreadyThere: before["status"] === target };
}

function budgetChange(action: Action, before: EntityState): Change {
  const field = before["daily_budget"] != null ? "daily_budget" : before["lifetime_budget"] != null ? "lifetime_budget" : null;
  if (!field) throw new Error("adjust_budget: entidade sem budget no nível (pré-check do guardrail deveria ter barrado)");

  const currentMinor = Number(before[field]);
  const pct = Number(action.params["pct"]);
  const signed = action.params["mode"] === "decrease" ? -pct : pct;
  const nextMinor = Math.max(MIN_BUDGET_MINOR, Math.round(currentMinor * (1 + signed / 100)));
  return { params: { [field]: String(nextMinor) }, alreadyThere: nextMinor === currentMinor };
}
