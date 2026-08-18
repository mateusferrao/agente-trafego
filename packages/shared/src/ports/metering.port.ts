import type { OrgId, UsageEvent } from "../types/index.js";

export interface UsageSummary {
  readonly orgId: OrgId;
  readonly period: string; // ex: "2026-08"
  readonly totalCostUsd: number;
  readonly byType: Readonly<Record<string, number>>;
}

/**
 * Borda de metering. Evento genérico (type + payload) → novas dimensões
 * de uso/cobrança sem migração. Base do billing (mensalidade + markup).
 */
export interface MeteringPort {
  record(event: UsageEvent): Promise<void>;
  summarize(orgId: OrgId, period: string): Promise<UsageSummary>;
  /** custo LLM acumulado no período (p/ cap de custo). */
  llmCostInPeriod(orgId: OrgId, period: string): Promise<number>;
}
