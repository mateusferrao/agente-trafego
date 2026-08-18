// Orquestrador do sync de insights (casca, worker). Por nível: watermark →
// planSyncWindow (core puro) → getInsights (adapter async) → upsert. Degradação
// graciosa: 190 → tokenInvalid (o worker marca token_status + avisa); upstream →
// partial=true e segue. Reusado pelo nó fetchData da 3a.

import type { AdsPlatformPort } from "@trafego/shared/ports";
import { AdsPlatformError } from "@trafego/shared/ports";
import type { EntityLevel } from "@trafego/shared";
import { planSyncWindow } from "@trafego/core";
import type { InsightsSnapshotsRepo, SnapshotRow } from "./repo.js";

const SYNC_LEVELS: readonly EntityLevel[] = ["account", "campaign", "adset", "ad"];
const DAILY = "1" as const;
// Campos comuns + o id do próprio nível (derivar entityId da linha).
const BASE_FIELDS = [
  "spend",
  "impressions",
  "clicks",
  "ctr",
  "cpc",
  "cpm",
  "frequency",
  "actions",
  "action_values",
] as const;
const LEVEL_ID_FIELD: Readonly<Record<EntityLevel, string>> = {
  account: "account_id",
  campaign: "campaign_id",
  adset: "adset_id",
  ad: "ad_id",
};

export interface SyncInput {
  readonly orgId: string;
  /** uuid de ad_accounts.id (FK do snapshot). */
  readonly adAccountUuid: string;
  /** ad account id da Meta (act id) p/ a API. */
  readonly metaAdAccountId: string;
  readonly accessToken: string;
  /** data de referência (YYYY-MM-DD), injetada pela casca. */
  readonly today: string;
}

export interface SyncResult {
  /** algum nível degradou (rate-limit/upstream) → análise parcial. */
  readonly partial: boolean;
  /** token inválido (190) → o worker marca token_status + avisa recolar. */
  readonly tokenInvalid: boolean;
  readonly snapshotsWritten: number;
}

export interface InsightsSyncServiceDeps {
  readonly ads: AdsPlatformPort;
  readonly repo: InsightsSnapshotsRepo;
  readonly refetchWindowDays: number;
  readonly retentionDays: number;
}

export interface InsightsSyncService {
  sync(input: SyncInput): Promise<SyncResult>;
}

export function createInsightsSyncService(deps: InsightsSyncServiceDeps): InsightsSyncService {
  return {
    async sync(input) {
      let partial = false;
      let snapshotsWritten = 0;

      for (const level of SYNC_LEVELS) {
        const latest = await deps.repo.latestDate(input.orgId, input.adAccountUuid, level);
        const window = planSyncWindow({
          today: input.today,
          latestSnapshotDate: latest,
          refetchWindowDays: deps.refetchWindowDays,
          retentionDays: deps.retentionDays,
        });
        if (!window) continue;

        try {
          const rows = await deps.ads.getInsights({
            account: { adAccountId: input.metaAdAccountId, accessToken: input.accessToken },
            level,
            window: `${window.since}..${window.until}`,
            timeIncrement: DAILY,
            fields: [...BASE_FIELDS, LEVEL_ID_FIELD[level]],
          });
          const snapshots: SnapshotRow[] = rows
            .filter((r) => r.date)
            .map((r) => ({
              orgId: input.orgId,
              adAccountId: input.adAccountUuid,
              entityLevel: r.level,
              entityId: r.entityId,
              date: r.date!,
              metrics: {
                metrics: r.metrics,
                ...(r.conversions ? { conversions: r.conversions } : {}),
                ...(r.rawActions ? { rawActions: r.rawActions } : {}),
              },
            }));
          if (snapshots.length > 0) {
            await deps.repo.upsertMany(snapshots);
            snapshotsWritten += snapshots.length;
          }
        } catch (error) {
          if (error instanceof AdsPlatformError && error.kind === "invalid_credential") {
            // token inválido não se resolve com retry — aborta e sinaliza p/ recolar.
            return { partial, tokenInvalid: true, snapshotsWritten };
          }
          // upstream/degradação → nível parcial, segue os demais (análise parcial).
          partial = true;
        }
      }

      return { partial, tokenInvalid: false, snapshotsWritten };
    },
  };
}
