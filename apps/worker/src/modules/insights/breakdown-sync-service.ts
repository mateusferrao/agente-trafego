// Sync de breakdown demográfico/posicionamento (S7, pivô saúde) — cadência PRÓPRIA,
// mais lenta que o sync diário (`sync-service.ts`): auto-throttle via `shouldSync`
// (mesma porta de staleness dos outros 4 gatilhos, §7) usando a última data gravada
// como watermark. Escopo: conta + campanhas ATIVAS já selecionadas pelo caller (reuso,
// sem listagem própria) — dimensões `demographic`+`placement`, agregado (sem diário).
// Degradação graciosa por combinação (nível×dimensão): uma falha não derruba as demais.

import type { AdsPlatformPort } from "@trafego/shared/ports";
import type { AgentGoals, BreakdownDimension, BreakdownSegment } from "@trafego/shared";
import { computeDerived, shouldSync, type NormalizedEntity } from "@trafego/core";
import type { BreakdownRow, InsightsBreakdownsRepo } from "./breakdown-repo.js";

const DIMENSIONS: readonly BreakdownDimension[] = ["demographic", "placement"];
const LEVELS = ["account", "campaign"] as const;
// Agregado da janela inteira — sem granularidade diária (o spread muda devagar).
const BREAKDOWN_WINDOW = "last_30d";

export interface BreakdownSyncInput {
  readonly orgId: string;
  readonly adAccountUuid: string;
  readonly metaAdAccountId: string;
  readonly accessToken: string;
  /** ids de campanha ATIVAS no escopo desta análise (o caller já as tem). */
  readonly campaignIds: readonly string[];
  readonly goals: AgentGoals;
  /** agora (ms epoch), injetado pela casca — decisão de staleness pura e testável. */
  readonly now: number;
}

export interface BreakdownSyncResult {
  /** `false` = ainda fresco (dentro da cadência própria) → pulou, sem chamada à Meta. */
  readonly synced: boolean;
}

export interface BreakdownSyncServiceDeps {
  readonly ads: AdsPlatformPort;
  readonly repo: InsightsBreakdownsRepo;
  readonly staleThresholdMin: number;
}

export interface BreakdownSyncService {
  sync(input: BreakdownSyncInput): Promise<BreakdownSyncResult>;
}

/** Resolve cpa/conversions do segmento contra a conversão de NEGÓCIO do agente (quando
 *  configurada) — reusa `computeDerived` (mesma fórmula do resto do sistema). Sem meta
 *  de negócio definida, o segmento fica só com os escalares base (ctr/cpc/cpm da Meta). */
function resolveSegmentCost(segment: BreakdownSegment, goals: AgentGoals): BreakdownSegment {
  if (!goals.conversionGoal) return segment;
  const pseudo: NormalizedEntity = {
    entityId: segment.key,
    level: "ad", // neutro — computeDerived não lê `level`
    spend: segment.metrics.spend,
    impressions: segment.metrics.impressions,
    clicks: segment.metrics.clicks,
    conversions: segment.conversions ?? [],
  };
  const override = {
    goal: goals.conversionGoal,
    ...(goals.customConversionId ? { customConversionId: goals.customConversionId } : {}),
  };
  const metrics = computeDerived(pseudo, undefined, override);
  return { ...segment, metrics };
}

export function createBreakdownSyncService(deps: BreakdownSyncServiceDeps): BreakdownSyncService {
  return {
    async sync(input) {
      // watermark representativo (dimensão "demographic", nível conta) — conta+campanhas
      // E as 2 dimensões sincronizam juntas no mesmo ciclo, então 1 watermark basta.
      const latestDate = await deps.repo.latestDate(input.orgId, input.adAccountUuid, "demographic");
      const latestSnapshotAt = latestDate ? Date.parse(`${latestDate}T00:00:00Z`) : null;
      if (!shouldSync({ latestSnapshotAt, now: input.now, thresholdMin: deps.staleThresholdMin })) {
        return { synced: false };
      }

      const today = new Date(input.now).toISOString().slice(0, 10);
      const account = { adAccountId: input.metaAdAccountId, accessToken: input.accessToken };
      const scopeIds = new Set(input.campaignIds);
      const rows: BreakdownRow[] = [];

      for (const dimension of DIMENSIONS) {
        for (const level of LEVELS) {
          try {
            const entityRows = await deps.ads.getBreakdownInsights({ account, level, window: BREAKDOWN_WINDOW, dimension });
            for (const er of entityRows) {
              if (level === "campaign" && !scopeIds.has(er.entityId)) continue; // só o escopo ativo desta análise
              rows.push({
                orgId: input.orgId,
                adAccountId: input.adAccountUuid,
                entityLevel: er.level,
                entityId: er.entityId,
                dimension,
                segments: er.segments.map((s) => resolveSegmentCost(s, input.goals)),
                date: today,
              });
            }
          } catch {
            // degradação graciosa (mesma filosofia do sync diário): pula esta combinação,
            // tenta de novo no próximo ciclo (cadência já é lenta, sem pressa de retry).
          }
        }
      }

      await deps.repo.upsertMany(rows);
      return { synced: true };
    },
  };
}
