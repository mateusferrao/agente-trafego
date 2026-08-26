// Máquina de dormância da conta (pivô) — PURO. Decide a transição de atividade a
// partir do estado atual + atividade recente + relógio. Dormância é ORTOGONAL ao
// lifecycle da conta e ao token: conta com token inválido / status ≠ active NUNCA
// entra na dormância (têm remédio próprio — recolar token / reconectar).

import type { SignalFinding } from "@trafego/shared";

export type ActivityState = "active" | "dormant";

/** Um dia em ms — relógio da dormância (last_activity_at / conexão). */
const DAY_MS = 24 * 60 * 60 * 1000;

export interface DormancyInput {
  /** houve atividade na janela? = spend>0 OU impressions>0 (predicado do brief). */
  readonly hasActivity: boolean;
  readonly currentState: ActivityState;
  /** epoch ms da última atividade vista; null = nunca teve. */
  readonly lastActivityAt: number | null;
  /** epoch ms de quando a conta foi conectada (fallback do relógio quando null). */
  readonly connectedAt: number;
  readonly now: number;
  /** dias sem atividade p/ virar dormante. */
  readonly afterDays: number;
  /** token válido? inválido → excluída da dormância. */
  readonly tokenValid: boolean;
  /** conta em lifecycle `active`? senão → excluída da dormância. */
  readonly accountActive: boolean;
}

export type DormancyTransition =
  /** nada a fazer. */
  | { readonly kind: "none" }
  /** dormant → active: a conta voltou a rodar (dispara reativação). */
  | { readonly kind: "reactivated" }
  /** active → dormant: N dias sem atividade (backoff do cron). */
  | { readonly kind: "went_dormant" }
  /** active e com atividade: só atualiza o relógio (last_activity_at). */
  | { readonly kind: "refresh_activity" };

/**
 * Decide a transição. Conta excluída (token inválido / não-active) → sempre `none`.
 * Com atividade: dormant→`reactivated`, senão `refresh_activity`. Sem atividade:
 * dormant→`none` (já dorme); active→`went_dormant` se `now - relógio ≥ afterDays`
 * (relógio = last_activity_at, ou a conexão quando nunca teve atividade — graça).
 */
export function evaluateDormancy(input: DormancyInput): DormancyTransition {
  if (!input.tokenValid || !input.accountActive) return { kind: "none" };

  if (input.hasActivity) {
    return input.currentState === "dormant" ? { kind: "reactivated" } : { kind: "refresh_activity" };
  }
  if (input.currentState === "dormant") return { kind: "none" };
  const clock = input.lastActivityAt ?? input.connectedAt;
  const idleDays = (input.now - clock) / DAY_MS;
  return idleDays >= input.afterDays ? { kind: "went_dormant" } : { kind: "none" };
}

/**
 * Sinal de reativação (nível conta) — sintetizado da transição, sem baseline (a
 * conta dormante não tem). Dirige o analista a olhar a retomada e concluir.
 */
export function reactivationSignal(accountId: string, accountName: string | null): SignalFinding {
  return {
    entityRef: { level: "account", id: accountId, ...(accountName ? { name: accountName } : {}) },
    metric: "spend",
    direction: "reactivated",
    magnitudePct: 100,
    current: 1,
    baseline: 0,
  };
}
