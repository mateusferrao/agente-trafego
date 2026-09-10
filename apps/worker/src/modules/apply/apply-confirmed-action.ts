// Núcleo compartilhado de aplicação de UMA ação já confirmada (5c-1): re-roda o
// guardrail (fresco/cross-run) → executa (idempotente/auditado/metered) → classifica o
// desfecho. Extraído do worker `approval-apply` (5b) p/ ser reusado também pela escrita
// livre por chat (5c). O EFEITO COLATERAL (resolver approval / push / responder inline)
// fica no chamador — aqui só a decisão + execução, retornando um resultado tipado.

import { and, eq } from "drizzle-orm";
import { agents, guardrailConfigs } from "@trafego/db";
import { applyGuardrails, type GuardrailContext } from "@trafego/core";
import { toGuardrailConfig } from "@trafego/shared";
import type { Action, GuardrailConfig } from "@trafego/shared/types";
import type { AdAccountRef, MutationResult } from "@trafego/shared/ports";
import type { WorkerDeps } from "../../composition.js";
import { createAnalysisRepo, loadDailyToolContext } from "../analysis/repo.js";
import { loadEnabledTools, enabledActionTypes } from "../tools/enabled.js";
import { makeMetaToolExecutor, type MetaToolExecutor } from "../../executors/meta-tools.js";

/** Desfecho RUNTIME de aplicar UMA ação confirmada (o chamador mapeia p/ seu I/O). Distinto do
 *  enum PERSISTIDO `ApplyOutcome` (@trafego/shared) — aqui carrega dryRun/result/error do momento;
 *  o worker traduz este `kind` (+ dryRun) pro enum ao gravar em `approvals.apply_outcome`. */
export type ApplyResult =
  | { readonly kind: "applied"; readonly dryRun: boolean; readonly result: MutationResult; readonly action: Action }
  | { readonly kind: "noop"; readonly action: Action }
  | { readonly kind: "blocked"; readonly reason: string; readonly action: Action }
  | { readonly kind: "failed"; readonly error: unknown; readonly action: Action };

/** before == after → o executor não escreveu (alvo já no estado desejado). */
function isNoWrite(result: MutationResult): boolean {
  return JSON.stringify(result.before) === JSON.stringify(result.after);
}

export interface CheckedApplyInput {
  readonly executor: Pick<MetaToolExecutor, "execute">;
  readonly account: AdAccountRef;
  readonly action: Action;
  readonly cfg: GuardrailConfig;
  readonly ctx: GuardrailContext;
  /** dono da ação (âncora do cap diário/undo/trilha). */
  readonly agentId: string;
  /** run de análise; null p/ escrita LIVRE por chat (5c). */
  readonly runId: string | null;
  readonly orgId: string;
  readonly idempotencyKey: string;
  /** força o dry-run (ex: preview do eco no chat, 5c); default = `cfg.dryRun`. */
  readonly dryRun?: boolean;
  /** isenta SÓ o cap de entidades/dia — ativação em cadeia confirmada (intenção única). */
  readonly exemptEntityCap?: boolean;
}

/**
 * Núcleo puro-ish (executor injetado + `applyGuardrails` puro) — testável sem db.
 * Guardrail barra → `blocked`; executor lança → `failed`; escrita real sem mudança →
 * `noop`; senão → `applied`. `input.dryRun` força o ensaio (preview do eco); sem ele,
 * herda de `cfg.dryRun`.
 */
export async function applyCheckedAction(input: CheckedApplyInput): Promise<ApplyResult> {
  const { executor, account, action, cfg, ctx, agentId, runId, orgId, idempotencyKey } = input;
  const dryRun = input.dryRun ?? cfg.dryRun;

  const check = applyGuardrails([action], cfg, ctx, { exemptEntityCap: input.exemptEntityCap ?? false });
  if (check.allowed.length === 0) {
    return { kind: "blocked", reason: check.dropped[0]?.reason ?? "barrada pelo guardrail", action };
  }
  const clamped = check.allowed[0]!;

  let done: Awaited<ReturnType<MetaToolExecutor["execute"]>>;
  try {
    done = await executor.execute({ agentId, runId, orgId, account, action: clamped, idempotencyKey, dryRun });
  } catch (error) {
    return { kind: "failed", error, action: clamped };
  }

  if (!done.dryRun && isNoWrite(done.result)) return { kind: "noop", action: clamped };
  return { kind: "applied", dryRun: done.dryRun, result: done.result, action: clamped };
}

export interface ApplyConfirmedInput {
  readonly orgId: string;
  readonly agentId: string;
  readonly action: Action;
  readonly runId: string;
  readonly idempotencyKey: string;
}

/**
 * Casca IO: resolve conta (via agente) + token + guardrail config + contexto cross-run
 * (24h) e chama `applyCheckedAction`. Reusado por `approval-apply` (site/WhatsApp) e pela
 * escrita livre por chat (5c). Conta indisponível → `blocked` (não é falha de Meta).
 */
export async function applyConfirmedAction(deps: WorkerDeps, input: ApplyConfirmedInput): Promise<ApplyResult> {
  const { db, ports } = deps;
  const repo = createAnalysisRepo(db);
  const executor = makeMetaToolExecutor(deps);

  const [ag] = await db
    .select({ adAccountId: agents.adAccountId })
    .from(agents)
    .where(eq(agents.id, input.agentId))
    .limit(1);
  const account = ag ? await repo.loadAccount(input.orgId, ag.adAccountId) : null;
  if (!account) return { kind: "blocked", reason: "conta indisponível", action: input.action };

  const accessToken = ports.vault.decrypt(account.tokenCripto);
  const ref: AdAccountRef = { adAccountId: account.metaAdAccountId, accessToken };

  const [guardrailRow] = await db
    .select()
    .from(guardrailConfigs)
    .where(and(eq(guardrailConfigs.agentId, input.agentId), eq(guardrailConfigs.orgId, input.orgId)))
    .limit(1);
  // A2: allowedActions AUTORITATIVA dos bindings (mesma fonte do gate do chat) — consistência.
  const baseCfg = toGuardrailConfig(guardrailRow);
  const enabled = await loadEnabledTools(db, input.orgId, input.agentId, baseCfg.allowedActions);
  const cfg: GuardrailConfig = { ...baseCfg, allowedActions: enabledActionTypes(enabled) };
  const daily = await loadDailyToolContext(db, input.agentId);

  return applyCheckedAction({
    executor,
    account: ref,
    action: input.action,
    cfg,
    ctx: { touchedToday: daily.touchedToday, budgetChangedToday: daily.budgetChangedToday },
    agentId: input.agentId,
    runId: input.runId,
    orgId: input.orgId,
    idempotencyKey: input.idempotencyKey,
  });
}
