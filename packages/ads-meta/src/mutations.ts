import type { Action, EntityLevel, TargetingSpec } from "@trafego/shared/types";
import type { AdAccountRef, MutateOptions, MutationResult, RestoreResult } from "@trafego/shared/ports";
import {
  ACTION_PARAM_AMOUNT_MINOR,
  ACTION_PARAM_MODE,
  ACTION_PARAM_PCT,
  ACTION_PARAM_TARGETING,
  BUDGET_MODE_DECREASE,
  BUDGET_MODE_SET,
} from "@trafego/shared";
import type { MetaGraphClient } from "./client.js";
import { explicitTargetingToRaw } from "./targeting-map.js";

/**
 * Mutações na Meta: pause/resume/adjust_budget/set_status + adjust_audience (Fatia C).
 *
 * Idempotência (§8): lê o estado atual (`before`) antes de escrever e evita reaplicar
 * quando o alvo já está no estado desejado (before==after, sem POST). A casca ainda
 * guarda `idempotency_key` em `agent_tool_calls`; aqui garantimos before/after p/ rollback.
 * O budget é tratado em **unidade mínima** (centavos), como a Graph reporta/aceita.
 *
 * `adjust_audience` escreve o `targeting` cru do adset (público NOVO, `TargetingSpec.explicit`
 * já resolvido nome→id). O before-image guarda o `targeting` CRU da Meta → revert fiel
 * (reset de aprendizado é irreversível — o Roy avisa; o revert só devolve o público antigo).
 */

const STATUS_ACTIVE = "ACTIVE";
const STATUS_PAUSED = "PAUSED";
/** Piso de segurança de budget (unidade mínima) — Meta rejeita valores muito baixos. */
const MIN_BUDGET_MINOR = 100;
/** Campo cru do público no adset (before-image + escrita de adjust_audience). */
const TARGETING_FIELD = "targeting";

type EntityState = Record<string, unknown>;

/** Campos lidos p/ before-image (status + budgets). ANÚNCIO não tem budget (o orçamento vive no
 *  adset/campanha) — pedir `daily_budget`/`lifetime_budget` num ad = erro Meta #100. */
const STATE_FIELDS = "status,effective_status,daily_budget,lifetime_budget";
const AD_STATE_FIELDS = "status,effective_status";
const stateFieldsFor = (level: EntityLevel | undefined): string => (level === "ad" ? AD_STATE_FIELDS : STATE_FIELDS);

/**
 * Mudança computada. Discriminada por tipo de escrita: `fields` (status/budget — params
 * já serializados) ou `targeting` (público cru — objeto, serializado só no POST). `alreadyThere`
 * = o alvo já está no estado desejado (no-op, sem POST).
 */
type Change =
  | { readonly kind: "fields"; readonly params: Readonly<Record<string, string>>; readonly alreadyThere: boolean }
  | { readonly kind: "targeting"; readonly targeting: Readonly<Record<string, unknown>>; readonly alreadyThere: boolean };

export class MetaMutationsService {
  private readonly client: MetaGraphClient;

  constructor(client: MetaGraphClient) {
    this.client = client;
  }

  /** Aplica a ação e retorna before/after (rollback). Idempotente por leitura.
   *  `dryRun` → lê + computa o after, mas NÃO escreve (ensaio). */
  async mutate(account: AdAccountRef, action: Action, opts?: MutateOptions): Promise<MutationResult> {
    const before = await this.readStateForAction(account, action);
    const change = computeChange(action, before);
    // after = intenção aplicada sobre o before (evita 2º GET; o undo restaura o before).
    const patch = change.kind === "targeting" ? { [TARGETING_FIELD]: change.targeting } : change.params;
    const after: EntityState = change.alreadyThere ? before : { ...before, ...patch };
    if (opts?.dryRun || change.alreadyThere) return { action, before, after };
    // targeting vai serializado como JSON num único campo `targeting`; status/budget vão diretos.
    const writeParams = change.kind === "targeting" ? { [TARGETING_FIELD]: JSON.stringify(change.targeting) } : change.params;
    await this.writeFields(account, action.target.id, writeParams);
    return { action, before, after };
  }

  /** Before-image por ação: `adjust_audience` inclui o `targeting` cru (revert fiel); as demais
   *  leem só status+budget. Mantém a leitura mínima por tipo (targeting é payload pesado). */
  private async readStateForAction(account: AdAccountRef, action: Action): Promise<EntityState> {
    if (action.type === "adjust_audience") {
      return this.readEntityStateFields(account, action.target.id, `${stateFieldsFor(action.target.level)},${TARGETING_FIELD}`);
    }
    return this.readEntityState(account, action.target.id, action.target.level);
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

  /** Lê o estado atual da entidade (status + budgets) p/ before-image. `level` opcional: "ad"
   *  omite os campos de budget (que não existem no anúncio) — evita o erro Meta #100. */
  async readEntityState(account: AdAccountRef, entityId: string, level?: EntityLevel): Promise<EntityState> {
    return this.readEntityStateFields(account, entityId, stateFieldsFor(level));
  }

  /** GET cru de campos arbitrários da entidade (base de `readEntityState` + before de targeting). */
  private async readEntityStateFields(account: AdAccountRef, entityId: string, fields: string): Promise<EntityState> {
    const res = await this.client.request<EntityState>({
      method: "GET",
      path: entityId,
      accessToken: account.accessToken,
      params: { fields },
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
    case "adjust_audience":
      return targetingChange(action, before);
    default:
      throw new Error(`mutação não suportada: ${action.type}`);
  }
}

function statusChange(before: EntityState, target: string): Change {
  return { kind: "fields", params: { status: target }, alreadyThere: before["status"] === target };
}

/**
 * Público NOVO (`adjust_audience`, Fatia C) → `targeting` cru da Meta. Só a variante `explicit`
 * (público resolvido nome→id na proposta) — reuse_adset/advantage_plus exigem IO e não entram aqui.
 * Idempotência: no-op quando TODO campo proposto já bate no targeting atual (subset match — o
 * targeting da Meta traz campos que não setamos; comparar o conjunto inteiro nunca casaria).
 */
function targetingChange(action: Action, before: EntityState): Change {
  const spec = action.params[ACTION_PARAM_TARGETING] as TargetingSpec | undefined;
  if (!spec || spec.kind !== "explicit") {
    throw new Error("adjust_audience: público explícito ausente/inválido nos params (o worker deveria ter resolvido)");
  }
  const targeting = explicitTargetingToRaw(spec);
  const current = (before[TARGETING_FIELD] ?? {}) as Record<string, unknown>;
  const alreadyThere = Object.keys(targeting).every((k) => JSON.stringify(targeting[k]) === JSON.stringify(current[k]));
  return { kind: "targeting", targeting, alreadyThere };
}

/**
 * Campos absolutos a reescrever no undo: status sempre; o budget só se o MESMO campo
 * ainda existir no estado atual (se a entidade trocou daily↔lifetime, não força o
 * campo antigo — a Meta rejeitaria e o undo falharia). `targeting` (Fatia C): reescreve o
 * público CRU anterior quando o before-image o capturou (só adjust_audience carrega) — sempre
 * (o adset sempre tem targeting; sem guarda de `current`, que a leitura de restore nem pede).
 */
function restoreFields(
  before: Readonly<Record<string, unknown>>,
  current: Readonly<Record<string, unknown>>,
): Record<string, string> {
  const fields: Record<string, string> = {};
  if (before["status"] != null) fields["status"] = String(before["status"]);
  if (before["daily_budget"] != null && current["daily_budget"] != null) fields["daily_budget"] = String(before["daily_budget"]);
  if (before["lifetime_budget"] != null && current["lifetime_budget"] != null) fields["lifetime_budget"] = String(before["lifetime_budget"]);
  if (before[TARGETING_FIELD] != null) fields[TARGETING_FIELD] = JSON.stringify(before[TARGETING_FIELD]);
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

  // budget ABSOLUTO (chat, 5c): alvo exato em unidade mínima (sem % sobre o atual).
  if (action.params[ACTION_PARAM_MODE] === BUDGET_MODE_SET) {
    const target = Number(action.params[ACTION_PARAM_AMOUNT_MINOR]);
    if (!Number.isFinite(target)) {
      throw new Error("adjust_budget set: amountMinor ausente/inválido");
    }
    const nextMinor = Math.max(MIN_BUDGET_MINOR, Math.round(target));
    return { kind: "fields", params: { [field]: String(nextMinor) }, alreadyThere: nextMinor === currentMinor };
  }

  const pct = Math.abs(Number(action.params[ACTION_PARAM_PCT]));
  if (!Number.isFinite(pct) || pct === 0) {
    throw new Error("adjust_budget: pct ausente/inválido (não deveria virar ação sem %)");
  }
  const signed = action.params[ACTION_PARAM_MODE] === BUDGET_MODE_DECREASE ? -pct : pct;
  const nextMinor = Math.max(MIN_BUDGET_MINOR, Math.round(currentMinor * (1 + signed / 100)));
  return { kind: "fields", params: { [field]: String(nextMinor) }, alreadyThere: nextMinor === currentMinor };
}
