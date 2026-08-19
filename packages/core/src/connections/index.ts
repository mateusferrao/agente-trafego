/**
 * Reconciliação de contas de uma conexão (núcleo puro — sem IO). Decide o que
 * fazer ao descobrir contas na plataforma (`sync`) ou ao aplicar a seleção do
 * dono (`select`). Invariantes (§8/§13): **aditiva e não-destrutiva** — nunca
 * deleta; conta que some vira `unavailable` (soft); resultado vazio jamais é lido
 * como "apagar tudo"; respeita o unique de conta por org (não duplica entre
 * conexões). A casca (slice `connections`) só aplica o plano via Drizzle.
 */
import type { AccessibleAccount } from "@trafego/shared";

export type AccountLifecycle = "active" | "unavailable" | "removed";

/** Conta já persistida sob a conexão (projeção mínima p/ a decisão). */
export interface ManagedAccount {
  readonly adAccountId: string;
  readonly status: AccountLifecycle;
}

/** Plano de uma redescoberta (`sincronizar`). */
export interface SyncPlan {
  /** contas desta conexão ainda acessíveis → atualizar metadados (name/currency). */
  readonly toRefresh: readonly AccessibleAccount[];
  /** ids que estavam `unavailable` e reapareceram → reativar. */
  readonly toReactivate: readonly string[];
  /** ids `active` que sumiram da plataforma → marcar `unavailable` (soft). */
  readonly toMarkUnavailable: readonly string[];
  /** contas acessíveis ainda não geridas → disponíveis p/ opt-in (não auto-ativa). */
  readonly newAvailable: readonly AccessibleAccount[];
  /** ids acessíveis já geridos por OUTRA conexão da org (respeita o unique). */
  readonly connectedElsewhere: readonly string[];
}

/** Plano da multi-seleção do dono (`gerenciar contas`). */
export interface SelectPlan {
  /** contas a criar/ativar (selecionadas ∩ acessíveis, não geridas alhures). */
  readonly toActivate: readonly AccessibleAccount[];
  /** ids `active` desmarcados → remover (soft). */
  readonly toRemove: readonly string[];
  /** ids selecionados que a plataforma não oferece → ignorados (com aviso). */
  readonly ignoredUnavailable: readonly string[];
  /** ids selecionados já geridos por outra conexão → não ativa aqui. */
  readonly connectedElsewhere: readonly string[];
}

export function reconcileSync(input: {
  available: readonly AccessibleAccount[];
  existingHere: readonly ManagedAccount[];
  managedElsewhereIds?: readonly string[];
}): SyncPlan {
  const elsewhere = new Set(input.managedElsewhereIds ?? []);
  const byId = new Map(input.existingHere.map((a) => [a.adAccountId, a.status]));
  const availableIds = new Set(input.available.map((a) => a.id));

  const toRefresh: AccessibleAccount[] = [];
  const toReactivate: string[] = [];
  const newAvailable: AccessibleAccount[] = [];
  const connectedElsewhere: string[] = [];

  for (const a of input.available) {
    if (elsewhere.has(a.id)) {
      connectedElsewhere.push(a.id);
      continue;
    }
    const status = byId.get(a.id);
    if (status === undefined) {
      newAvailable.push(a);
      continue;
    }
    toRefresh.push(a);
    if (status === "unavailable") toReactivate.push(a.id);
  }

  // Ativas que não vieram na descoberta → soft-unavailable (preserva tudo).
  const toMarkUnavailable = input.existingHere
    .filter((a) => a.status === "active" && !availableIds.has(a.adAccountId))
    .map((a) => a.adAccountId);

  return { toRefresh, toReactivate, toMarkUnavailable, newAvailable, connectedElsewhere };
}

export function reconcileSelect(input: {
  available: readonly AccessibleAccount[];
  existingHere: readonly ManagedAccount[];
  selectedIds: readonly string[];
  managedElsewhereIds?: readonly string[];
}): SelectPlan {
  const elsewhere = new Set(input.managedElsewhereIds ?? []);
  const availableById = new Map(input.available.map((a) => [a.id, a]));
  const selected = new Set(input.selectedIds);

  const toActivate: AccessibleAccount[] = [];
  const ignoredUnavailable: string[] = [];
  const connectedElsewhere: string[] = [];

  for (const id of selected) {
    const account = availableById.get(id);
    if (!account) {
      ignoredUnavailable.push(id);
      continue;
    }
    if (elsewhere.has(id)) {
      connectedElsewhere.push(id);
      continue;
    }
    toActivate.push(account);
  }

  // Geridas ativas que o dono desmarcou → soft-remove.
  const toRemove = input.existingHere
    .filter((a) => a.status === "active" && !selected.has(a.adAccountId))
    .map((a) => a.adAccountId);

  return { toActivate, toRemove, ignoredUnavailable, connectedElsewhere };
}
