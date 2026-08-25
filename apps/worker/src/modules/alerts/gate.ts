// Gate do ALERTA proativo (F4): roda ao fim do sync (dados novos), determinístico e
// barato (sem LLM). Carrega a política de alerta do agente, aplica throttle, compara
// D-1 vs baseline (só dias fechados) e, se cruza o limiar, dispara UM run dirigido
// (trigger "signal") com o sinal mais forte — a ANÁLISE decide se comunica. O sinal
// nunca fala sozinho.

import { and, eq, gte } from "drizzle-orm";
import { agentRuns, agents, insightsSnapshots, loadOrgTimezone, type Database } from "@trafego/db";
import { addDays, detectMaterialChange, startOfDayInTz, todayInTz } from "@trafego/core";
import type { NotifyPolicy } from "@trafego/shared";
import type { Logger } from "pino";
import type { CronDispatchInput, DispatchOutcome } from "../dispatch/run-dispatcher.js";
import { buildSignalComparisons, strongestSignal, type SnapshotDay } from "./aggregate.js";

/** Janela de snapshots lida p/ montar D-1 + baseline. */
const ALERT_LOOKBACK_DAYS = 9;
const CAMPAIGN_LEVEL = "campaign" as const;
const MS_PER_HOUR = 3_600_000;

export interface AlertGateDeps {
  readonly db: Database;
  readonly logger: Logger;
  /** injetável (testável): cria run "signal" via RunDispatcher. */
  readonly dispatch: (input: CronDispatchInput) => Promise<DispatchOutcome>;
  readonly now?: () => Date;
}

export interface AlertGateInput {
  readonly orgId: string;
  readonly agentId: string;
  readonly adAccountId: string;
  /** fallback do fuso (ANALYSIS_TZ) quando a org não tem timezone. */
  readonly fallbackTz: string;
}

export type AlertGateOutcome = "disabled" | "throttled" | "no_data" | "no_signal" | "dispatched";

/**
 * Início da janela de throttle: o mais RESTRITIVO entre "throttleHours atrás" e o começo
 * do dia CIVIL no fuso da org. O sinal é sobre D-1 (muda 1×/dia), então um throttleHours
 * curto (ex: 3h) não pode re-alertar o MESMO dia fechado várias vezes — o piso do dia
 * garante ≤1/dia, agora alinhado ao dia civil da org (não à meia-noite UTC).
 */
export function throttleWindowStart(now: Date, throttleHours: number, tz: string): Date {
  const startOfDay = startOfDayInTz(now, tz).getTime();
  return new Date(Math.min(now.getTime() - throttleHours * MS_PER_HOUR, startOfDay));
}

export async function runAlertGate(deps: AlertGateDeps, input: AlertGateInput): Promise<AlertGateOutcome> {
  const now = deps.now ?? (() => new Date());
  // fuso da org — datas/janela do gate no fuso, não UTC.
  const tz = await loadOrgTimezone(deps.db, input.orgId, input.fallbackTz);

  // 1) política de alerta do agente (desligada → nada).
  const [ag] = await deps.db
    .select({ notifyPolicy: agents.notifyPolicy })
    .from(agents)
    .where(and(eq(agents.id, input.agentId), eq(agents.orgId, input.orgId)))
    .limit(1);
  const policy = ag?.notifyPolicy as NotifyPolicy | undefined;
  if (!policy?.alerts.enabled) return "disabled";
  const { sensitivity, throttleHours } = policy.alerts;

  // 2) throttle: já houve um signal-run na janela? (máx 1 — sem spam/custo; ≤1/dia).
  const since = throttleWindowStart(now(), throttleHours, tz);
  const [recent] = await deps.db
    .select({ id: agentRuns.id })
    .from(agentRuns)
    .where(and(eq(agentRuns.agentId, input.agentId), eq(agentRuns.trigger, "signal"), gte(agentRuns.createdAt, since)))
    .limit(1);
  if (recent) return "throttled";

  // 3) snapshots por campanha (janela curta) → comparações D-1 vs baseline.
  const lookback = addDays(todayInTz(now(), tz), -ALERT_LOOKBACK_DAYS);
  const rows = await deps.db
    .select({ entityId: insightsSnapshots.entityId, date: insightsSnapshots.date, metricsJson: insightsSnapshots.metricsJson })
    .from(insightsSnapshots)
    .where(
      and(
        eq(insightsSnapshots.orgId, input.orgId),
        eq(insightsSnapshots.adAccountId, input.adAccountId),
        eq(insightsSnapshots.entityLevel, CAMPAIGN_LEVEL),
        gte(insightsSnapshots.date, lookback),
      ),
    );
  if (rows.length === 0) return "no_data";

  const days: SnapshotDay[] = rows.map((r) => {
    const m = r.metricsJson?.metrics ?? {};
    return {
      entityId: r.entityId,
      level: CAMPAIGN_LEVEL,
      date: r.date,
      ...(typeof m.spend === "number" ? { spend: m.spend } : {}),
      ...(typeof m.conversions === "number" ? { results: m.conversions } : {}),
      ...(typeof m.cpa === "number" ? { cpa: m.cpa } : {}),
    };
  });

  const comparisons = buildSignalComparisons(days, todayInTz(now(), tz));
  const top = strongestSignal(detectMaterialChange(comparisons, sensitivity));
  if (!top) return "no_signal";

  // 4) dispara o run dirigido — a análise investiga o ponto e decide se comunica.
  const outcome = await deps.dispatch({
    orgId: input.orgId,
    agentId: input.agentId,
    adAccountId: input.adAccountId,
    trigger: "signal",
    signalFinding: top,
  });
  deps.logger.info(
    { agentId: input.agentId, metric: top.metric, direction: top.direction, magnitudePct: top.magnitudePct, outcome },
    "alert:signal disparado",
  );
  return "dispatched";
}
