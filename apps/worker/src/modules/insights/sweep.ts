// Sweep de frescura (6a-2): varre as contas ATIVAS (agente ativo + conta active),
// aplica a porta `shouldSync` (core puro) e enfileira sync-only só p/ as velhas, com
// stagger (spread sobre a janela de jitter). Sem LLM. Consumido pelo worker singleton.

import { and, eq } from "drizzle-orm";
import type { Database } from "@trafego/db/client";
import { adAccounts, agents } from "@trafego/db";
import { shouldSync } from "@trafego/core";
import { buildInsightsSyncJob } from "@trafego/shared";
import type { SchedulerPort } from "@trafego/shared/ports";
import type { Logger } from "pino";
import type { InsightsSnapshotsRepo } from "./repo.js";

export interface InsightsSweepDeps {
  readonly db: Database;
  readonly repo: InsightsSnapshotsRepo;
  readonly scheduler: SchedulerPort;
  readonly logger: Logger;
  /** limite de frescura (min) — `INSIGHTS_FRESH_THRESHOLD_MIN`. */
  readonly thresholdMin: number;
  /** limite LENTO p/ contas dormantes — `DORMANT_SWEEP_INTERVAL_MIN` (corta chamadas Meta). */
  readonly dormantThresholdMin: number;
  /** agora (ms) injetado p/ testabilidade determinística. */
  readonly now: () => number;
  /** janela (ms) p/ espalhar os enqueues (stagger anti-thundering-herd). */
  readonly staggerWindowMs: number;
}

export interface InsightsSweep {
  sweep(): Promise<{ scanned: number; enqueued: number }>;
}

export function createInsightsSweep(deps: InsightsSweepDeps): InsightsSweep {
  return {
    async sweep() {
      // contas sob gestão (cross-org — singleton): agente ativo + conta lifecycle active.
      // Agente pausado NÃO entra (fica fresco via lazy on-view quando aberto — decisão 6a).
      const rows = await deps.db
        .select({ orgId: agents.orgId, accountId: agents.adAccountId, activityState: adAccounts.activityState })
        .from(agents)
        .innerJoin(adAccounts, eq(agents.adAccountId, adAccounts.id))
        .where(and(eq(agents.status, "active"), eq(adAccounts.status, "active")));

      const latest = await deps.repo.latestSyncedAtByAccounts(rows.map((r) => r.accountId));
      const now = deps.now();
      const stale = rows.filter((r) => {
        const at = latest.get(r.accountId);
        // conta dormante é varrida numa cadência LENTA (só p/ pegar a reativação).
        const thresholdMin = r.activityState === "dormant" ? deps.dormantThresholdMin : deps.thresholdMin;
        return shouldSync({ latestSnapshotAt: at ? at.getTime() : null, now, thresholdMin });
      });

      // spread uniforme sobre a janela de stagger (não estoura a Meta juntas).
      const step = stale.length > 1 ? Math.floor(deps.staggerWindowMs / stale.length) : 0;
      for (let i = 0; i < stale.length; i += 1) {
        const r = stale[i]!;
        await deps.scheduler.enqueue({
          ...buildInsightsSyncJob({ accountId: r.accountId, orgId: r.orgId, trigger: "cron" }),
          delayMs: i * step,
        });
      }

      deps.logger.debug({ scanned: rows.length, enqueued: stale.length }, "sweep:tick");
      return { scanned: rows.length, enqueued: stale.length };
    },
  };
}
