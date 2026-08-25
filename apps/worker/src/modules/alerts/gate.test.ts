import { describe, expect, it, vi } from "vitest";
import { agentRuns, agents, insightsSnapshots } from "@trafego/db";
import type { NotifyPolicy } from "@trafego/shared";
import { runAlertGate, throttleWindowStart, type AlertGateDeps } from "./gate.js";
import type { CronDispatchInput, DispatchOutcome } from "../dispatch/run-dispatcher.js";

/** Mock tipado do dispatch (assinatura do RunDispatcher). */
function fakeDispatch(outcome: DispatchOutcome = "enqueued") {
  return vi.fn(async (_input: CronDispatchInput): Promise<DispatchOutcome> => outcome);
}

const ON: NotifyPolicy = {
  pulse: { enabled: false, cadence: { kind: "daily", hour: 8 } },
  alerts: { enabled: true, sensitivity: "normal", throttleHours: 6 },
  runPush: { enabled: true },
};
const OFF: NotifyPolicy = { ...ON, alerts: { ...ON.alerts, enabled: false } };

/** db falso keyed por tabela (mesmo padrão do read-data.test). */
function fakeDb(byTable: Map<unknown, unknown[]>) {
  let current: unknown[] = [];
  const chain: Record<string, unknown> = {
    select: () => chain,
    from: (t: unknown) => {
      current = byTable.get(t) ?? [];
      return chain;
    },
    where: () => chain,
    limit: () => chain,
    then: (r: (v: unknown[]) => unknown) => r(current),
  };
  return chain as never;
}

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never;
const INPUT = { orgId: "o", agentId: "a", adAccountId: "acc", fallbackTz: "UTC" };

function snap(entityId: string, date: string, metrics: Record<string, number>) {
  return { entityId, date, metricsJson: { metrics } };
}

describe("throttleWindowStart (dedupe por dia)", () => {
  const now = new Date("2026-08-23T10:00:00Z");

  it("throttleHours curto (3h) ainda cobre desde o início do dia (não re-alerta o mesmo D-1)", () => {
    // 3h atrás = 07:00; início do dia = 00:00 → vence o mais restritivo (00:00).
    expect(throttleWindowStart(now, 3, "UTC").toISOString()).toBe("2026-08-23T00:00:00.000Z");
  });

  it("throttleHours longo (>tempo desde meia-noite) manda além do início do dia", () => {
    // 24h atrás = ontem 10:00, mais restritivo que 00:00 de hoje.
    expect(throttleWindowStart(now, 24, "UTC").toISOString()).toBe("2026-08-22T10:00:00.000Z");
  });
});

describe("runAlertGate", () => {
  it("política de alerta desligada → disabled (nada dispara)", async () => {
    const db = fakeDb(new Map([[agents, [{ notifyPolicy: OFF }]]]));
    const dispatch = fakeDispatch();
    const r = await runAlertGate({ db, logger, dispatch } as AlertGateDeps, INPUT);
    expect(r).toBe("disabled");
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("signal-run recente → throttled (sem novo disparo)", async () => {
    const db = fakeDb(
      new Map<unknown, unknown[]>([
        [agents, [{ notifyPolicy: ON }]],
        [agentRuns, [{ id: "run-recente" }]],
      ]),
    );
    const dispatch = fakeDispatch();
    const r = await runAlertGate({ db, logger, dispatch } as AlertGateDeps, INPUT);
    expect(r).toBe("throttled");
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("mudança material → dispara run signal com o sinal mais forte", async () => {
    const now = () => new Date("2026-08-23T10:00:00Z");
    const rows = [
      snap("c1", "2026-08-20", { conversions: 10, spend: 100 }),
      snap("c1", "2026-08-21", { conversions: 10, spend: 100 }),
      snap("c1", "2026-08-22", { conversions: 3, spend: 100 }), // queda de resultado ~70%
    ];
    const db = fakeDb(
      new Map<unknown, unknown[]>([
        [agents, [{ notifyPolicy: ON }]],
        [agentRuns, []], // sem run recente
        [insightsSnapshots, rows],
      ]),
    );
    const dispatch = fakeDispatch();
    const r = await runAlertGate({ db, logger, dispatch, now } as AlertGateDeps, INPUT);
    expect(r).toBe("dispatched");
    expect(dispatch).toHaveBeenCalledOnce();
    const arg = dispatch.mock.calls[0]![0];
    expect(arg.trigger).toBe("signal");
    expect(arg.signalFinding).toMatchObject({ metric: "results", direction: "drop" });
  });

  it("conta estável → no_signal (nada dispara)", async () => {
    const now = () => new Date("2026-08-23T10:00:00Z");
    const rows = [
      snap("c1", "2026-08-21", { conversions: 10, spend: 100 }),
      snap("c1", "2026-08-22", { conversions: 10, spend: 100 }),
    ];
    const db = fakeDb(
      new Map<unknown, unknown[]>([
        [agents, [{ notifyPolicy: ON }]],
        [agentRuns, []],
        [insightsSnapshots, rows],
      ]),
    );
    const dispatch = fakeDispatch();
    const r = await runAlertGate({ db, logger, dispatch, now } as AlertGateDeps, INPUT);
    expect(r).toBe("no_signal");
    expect(dispatch).not.toHaveBeenCalled();
  });
});
