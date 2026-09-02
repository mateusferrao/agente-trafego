// Medição de outcome de AÇÕES NOSSAS (Sinal A, S4) — casca org-scoped. Liga uma
// recomendação (proposedAction) à ação REALMENTE aplicada (agent_tool_calls com
// before_state, não dry-run) no mesmo run, agrega as janelas antes/depois de
// insights_snapshots e grava o desfecho + a lição de calibração ATOMICAMENTE (uma
// transação por recomendação — crash não mede-sem-aprender). O core decide (computeOutcome/
// detectCalibrationCandidate); aqui só há IO.

import { and, between, eq, gte, isNotNull, lte, sql } from "drizzle-orm";
import {
  agentMemory,
  agentRuns,
  agentToolCalls,
  agents,
  entityConfigSnapshots,
  insightsSnapshots,
  recommendationFeedback,
  recommendations,
  type Database,
} from "@trafego/db";
import type { Action, ActionType, EntityConfigSnapshot, EntityLevel } from "@trafego/shared";
import { THRESHOLD_PROPOSAL_CONFIDENCE, computeConfidence, lessonKeyOf, proposalForCalibration, type EntityConfigDelta, type LessonCandidate, type MeasuredOutcome, type OutcomeWindow } from "@trafego/core";
import { buildLessonRow } from "./lesson-row.js";

const CAMPAIGN_LEVEL: EntityLevel = "campaign";

/** Recomendação com ação de plataforma, elegível à medição (janela madura, ainda não medida). */
export interface MeasurableRec {
  readonly recId: string;
  readonly runId: string;
  readonly adAccountId: string;
  readonly actionType: ActionType;
  readonly params: Readonly<Record<string, unknown>>;
  readonly entityId: string;
  readonly entityLevel: EntityLevel;
}

export interface CommitOutcomeInput {
  readonly orgId: string;
  readonly agentId: string;
  readonly recId: string;
  readonly outcome: MeasuredOutcome;
  readonly metrics: Record<string, unknown>;
  /** lição de calibração a criar/reforçar (quando o outcome vira cautela acionável). */
  readonly calibration?: { readonly candidate: LessonCandidate; readonly content: string; readonly runId?: string };
  /** lição existente a enfraquecer (o outcome contradiz a conclusão dela). */
  readonly contradiction?: { readonly semanticKey: string; readonly confidence: number; readonly demoteToStale: boolean };
}

/** Mudança de config detectada (prev→curr) cuja janela pós-mudança já fechou. */
export interface MaturedConfigChange {
  readonly entityId: string;
  readonly entityLevel: EntityLevel;
  readonly changeDate: string;
  readonly prev: EntityConfigDelta;
  readonly curr: EntityConfigDelta;
}

export interface OutcomeRepo {
  loadMeasurableRecs(orgId: string, agentId: string, notBefore: Date, notAfter: Date): Promise<MeasurableRec[]>;
  /** Mudanças de config (prev→curr) do gestor cuja data está na janela madura [from,to]. */
  loadMaturedConfigChanges(adAccountId: string, from: string, to: string): Promise<MaturedConfigChange[]>;
  /** Houve ação NOSSA aplicada nessa entidade no intervalo? (exclui nossa mudança da "manual"). */
  hasAppliedActionInRange(agentId: string, entityId: string, from: Date, to: Date): Promise<boolean>;
  /** instante da 1ª aplicação REAL da ação naquela entidade (não dry-run, com before_state). */
  findAppliedInstant(runId: string, entityId: string): Promise<Date | null>;
  /** janela agregada (spend + conversões de negócio) de uma entidade OU da conta (entityId null). */
  loadWindow(adAccountId: string, entityId: string | null, from: string, to: string): Promise<OutcomeWindow>;
  commitOutcome(input: CommitOutcomeInput): Promise<void>;
}

export function createOutcomeRepo(db: Database): OutcomeRepo {
  return {
    async loadMeasurableRecs(orgId, agentId, notBefore, notAfter) {
      const rows = await db
        .select({ recId: recommendations.id, runId: recommendations.runId, action: recommendations.proposedAction, adAccountId: agents.adAccountId })
        .from(recommendations)
        .innerJoin(agentRuns, eq(recommendations.runId, agentRuns.id))
        .innerJoin(agents, eq(agentRuns.agentId, agents.id))
        .where(
          and(
            eq(recommendations.orgId, orgId),
            eq(agentRuns.agentId, agentId),
            isNotNull(recommendations.proposedAction),
            between(recommendations.createdAt, notBefore, notAfter),
            // ainda não medida (sem linha de feedback com measured_at).
            sql`not exists (select 1 from ${recommendationFeedback} f where f.recommendation_id = ${recommendations.id} and f.measured_at is not null)`,
          ),
        );
      const out: MeasurableRec[] = [];
      for (const r of rows) {
        const action = r.action as Action | null;
        if (!action?.target?.id) continue;
        out.push({
          recId: r.recId,
          runId: r.runId,
          adAccountId: r.adAccountId,
          actionType: action.type,
          params: action.params ?? {},
          entityId: action.target.id,
          entityLevel: action.target.level,
        });
      }
      return out;
    },

    async loadMaturedConfigChanges(adAccountId, from, to) {
      // carrega snapshots até `to` (com folga p/ ter o "prev"), pareia por entidade e emite
      // a mudança cuja data (curr) cai em [from,to] (janela madura). Cadência = análise.
      const rows = await db
        .select({ entityId: entityConfigSnapshots.entityId, level: entityConfigSnapshots.entityLevel, date: entityConfigSnapshots.date, config: entityConfigSnapshots.configJson })
        .from(entityConfigSnapshots)
        .where(and(eq(entityConfigSnapshots.adAccountId, adAccountId), lte(entityConfigSnapshots.date, to)))
        .orderBy(entityConfigSnapshots.entityId, entityConfigSnapshots.date);
      const byEntity = new Map<string, { level: EntityLevel; date: string; config: EntityConfigSnapshot }[]>();
      for (const r of rows) {
        const list = byEntity.get(r.entityId) ?? [];
        list.push({ level: r.level, date: r.date, config: r.config });
        byEntity.set(r.entityId, list);
      }
      const out: MaturedConfigChange[] = [];
      for (const [entityId, snaps] of byEntity) {
        for (let i = 1; i < snaps.length; i++) {
          const curr = snaps[i]!;
          if (curr.date < from || curr.date > to) continue;
          out.push({ entityId, entityLevel: curr.level, changeDate: curr.date, prev: snaps[i - 1]!.config, curr: curr.config });
        }
      }
      return out;
    },

    async hasAppliedActionInRange(agentId, entityId, from, to) {
      const [row] = await db
        .select({ id: agentToolCalls.id })
        .from(agentToolCalls)
        .where(
          and(
            eq(agentToolCalls.agentId, agentId),
            isNotNull(agentToolCalls.beforeState),
            sql`${agentToolCalls.args} -> 'target' ->> 'id' = ${entityId}`,
            // exclui dry-run: uma simulação nossa NÃO é "ação aplicada" (senão suprimiria
            // o aprendizado da mudança MANUAL do gestor na mesma entidade).
            sql`coalesce((${agentToolCalls.args} ->> 'dryRun')::boolean, false) = false`,
            between(agentToolCalls.createdAt, from, to),
          ),
        )
        .limit(1);
      return row !== undefined;
    },

    async findAppliedInstant(runId, entityId) {
      const [row] = await db
        .select({ at: agentToolCalls.createdAt })
        .from(agentToolCalls)
        .where(
          and(
            eq(agentToolCalls.runId, runId),
            isNotNull(agentToolCalls.beforeState),
            sql`${agentToolCalls.args} -> 'target' ->> 'id' = ${entityId}`,
            sql`coalesce((${agentToolCalls.args} ->> 'dryRun')::boolean, false) = false`,
          ),
        )
        .orderBy(agentToolCalls.createdAt)
        .limit(1);
      return row?.at ?? null;
    },

    async loadWindow(adAccountId, entityId, from, to) {
      const rows = await db
        .select({ metrics: insightsSnapshots.metricsJson })
        .from(insightsSnapshots)
        .where(
          and(
            eq(insightsSnapshots.adAccountId, adAccountId),
            entityId
              ? eq(insightsSnapshots.entityId, entityId)
              : eq(insightsSnapshots.entityLevel, CAMPAIGN_LEVEL), // conta = soma das campanhas
            gte(insightsSnapshots.date, from),
            lte(insightsSnapshots.date, to),
          ),
        );
      let spend = 0;
      let results = 0;
      for (const r of rows) {
        const m = (r.metrics as { metrics?: { spend?: number; conversions?: number } } | null)?.metrics ?? {};
        if (typeof m.spend === "number") spend += m.spend;
        if (typeof m.conversions === "number") results += m.conversions;
      }
      return { spend, results, ...(results > 0 ? { cpa: spend / results } : {}) };
    },

    async commitOutcome({ orgId, agentId, recId, outcome, metrics, calibration, contradiction }) {
      await db.transaction(async (tx) => {
        await tx.insert(recommendationFeedback).values({
          recommendationId: recId,
          outcome,
          outcomeMetrics: metrics,
          measuredAt: sql`now()`,
        });
        if (calibration) {
          const key = lessonKeyOf(calibration.candidate.key);
          const [existing] = await tx
            .select({ id: agentMemory.id, confidence: agentMemory.confidence, confirmedByHuman: agentMemory.confirmedByHuman })
            .from(agentMemory)
            .where(and(eq(agentMemory.agentId, agentId), eq(agentMemory.semanticKey, key), sql`${agentMemory.lifecycle} <> 'archived'`))
            .limit(1);
          if (existing) {
            // reforço = a medição SUSTENTOU a cautela → sobe da confiança ATUAL rumo ao teto
            // medido (não sobrescreve com um valor fixo, que não subiria nem rebaixaria uma
            // lição já mais forte — ex: confirmada).
            const next = computeConfidence(existing.confidence, { type: "measured", positive: true });
            // calibração de ALTA confiança e AINDA NÃO confirmada pode PROPOR ajustar um limiar
            // (S6) — só o intent. Se o dono já confirmou/aceitou, NÃO re-oferece (senão o aceite
            // repetido apertaria o limiar de novo). A UI mostra em linguagem de comportamento.
            const proposal =
              next >= THRESHOLD_PROPOSAL_CONFIDENCE && !existing.confirmedByHuman
                ? proposalForCalibration(calibration.candidate.kind, calibration.candidate.key.dimension)
                : null;
            await tx
              .update(agentMemory)
              .set({
                confidence: next,
                reinforceCount: sql`${agentMemory.reinforceCount} + 1`,
                lastReinforcedAt: sql`now()`,
                lifecycle: "active",
                ...(proposal ? { proposedThresholdPatch: { ...proposal } as Record<string, unknown> } : {}),
                updatedAt: sql`now()`,
              })
              .where(eq(agentMemory.id, existing.id));
          } else {
            await tx.insert(agentMemory).values(
              buildLessonRow(calibration.candidate, {
                orgId,
                agentId,
                content: calibration.content,
                evidenceAt: new Date(),
                sourceRecommendationId: recId,
                ...(calibration.runId ? { sourceRunId: calibration.runId } : {}),
              }),
            );
          }
        }
        if (contradiction) {
          await tx
            .update(agentMemory)
            .set({
              confidence: contradiction.confidence,
              lastContradictedAt: sql`now()`,
              updatedAt: sql`now()`,
              ...(contradiction.demoteToStale ? { lifecycle: "stale" as const } : {}),
            })
            .where(and(eq(agentMemory.agentId, agentId), eq(agentMemory.semanticKey, contradiction.semanticKey), sql`${agentMemory.lifecycle} <> 'archived'`));
        }
      });
    },
  };
}
