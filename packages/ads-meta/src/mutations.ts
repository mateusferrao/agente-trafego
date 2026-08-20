import type { Action } from "@trafego/shared/types";
import type { AdAccountRef, MutateOptions, MutationResult, RestoreResult } from "@trafego/shared/ports";
import { ACTION_PARAM_MODE, ACTION_PARAM_PCT, BUDGET_MODE_DECREASE } from "@trafego/shared";
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

  /** Undo: reaplica o estado anterior (status + budget ABSOLUTOS) da entidade. */
  async restoreEntityState(
    account: AdAccountRef,
    entityId: string,
    before: Readonly<Record<string, unknown>>,
  ): Promise<RestoreResult> {
    const current = await this.readEntityState(account, entityId);
    const fields = restoreFields(before, current);
    if (Object.keys(fields).length > 0) await this.writeFields(account, entityId, fields);
    return { before: current, after: { ...current, ...fields } };
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

/**
 * Campos absolutos a reescrever no undo: status sempre; o budget só se o MESMO campo
 * ainda existir no estado atual (se a entidade trocou daily↔lifetime, não força o
 * campo antigo — a Meta rejeitaria e o undo falharia).
 */
function restoreFields(
  before: Readonly<Record<string, unknown>>,
  current: Readonly<Record<string, unknown>>,
): Record<string, string> {
  const fields: Record<string, string> = {};
  if (before["status"] != null) fields["status"] = String(before["status"]);
  if (before["daily_budget"] != null && current["daily_budget"] != null) fields["daily_budget"] = String(before["daily_budget"]);
  if (before["lifetime_budget"] != null && current["lifetime_budget"] != null) fields["lifetime_budget"] = String(before["lifetime_budget"]);
  return fields;
}

/** Campo de budget do nível (daily preferido) com valor > 0; senão null (sem budget próprio). */
function budgetField(before: EntityState): "daily_budget" | "lifetime_budget" | null {
  if (Number(before["daily_budget"]) > 0) return "daily_budget";
  if (Number(before["lifetime_budget"]) > 0) return "lifetime_budget";
  return null;
}

function budgetChange(action: Action, before: EntityState): Change {
  const field = budgetField(before);
  // budget 0/ausente (ex: CBO na campanha) → o nível não tem budget próprio p/ ajustar.
  if (!field) throw new Error("adjust_budget: entidade sem budget no nível (pré-check do guardrail deveria ter barrado)");

  const currentMinor = Number(before[field]);
  const pct = Math.abs(Number(action.params[ACTION_PARAM_PCT]));
  if (!Number.isFinite(pct) || pct === 0) {
    throw new Error("adjust_budget: pct ausente/inválido (não deveria virar ação sem %)");
  }
  const signed = action.params[ACTION_PARAM_MODE] === BUDGET_MODE_DECREASE ? -pct : pct;
  const nextMinor = Math.max(MIN_BUDGET_MINOR, Math.round(currentMinor * (1 + signed / 100)));
  return { params: { [field]: String(nextMinor) }, alreadyThere: nextMinor === currentMinor };
}
