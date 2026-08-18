import type { EntityLevel, InsightRow } from "@trafego/shared/types";
import type { InsightsQuery } from "@trafego/shared/ports";
import type { MetaGraphClient } from "./client.js";

/** Prefixo obrigatório do ad account no path da Graph API. */
const AD_ACCOUNT_PREFIX = "act_";

/** Linha crua de insights da Meta (valores vêm como string). */
interface MetaInsightRow {
  readonly spend?: string;
  readonly impressions?: string;
  readonly clicks?: string;
  readonly ctr?: string;
  readonly cpc?: string;
  readonly cpm?: string;
  readonly [key: string]: unknown;
}

function normalizeAdAccountId(id: string): string {
  return id.startsWith(AD_ACCOUNT_PREFIX) ? id : `${AD_ACCOUNT_PREFIX}${id}`;
}

function toNumber(value: unknown): number {
  const n = typeof value === "string" ? Number(value) : typeof value === "number" ? value : NaN;
  return Number.isFinite(n) ? n : 0;
}

/**
 * Mapeia a linha crua p/ InsightRow. Fatia 0 busca só `spend`; as demais métricas
 * (obrigatórias no tipo) ficam 0 até a coleta completa (fatia 2a). Sem `date` =
 * agregado da janela (não é série diária).
 *
 * ⚠️ Fatia 2a: para níveis campaign/adset/ad, derivar `entityId` do id da própria
 * linha (`campaign_id`/`adset_id`/`ad_id`/`id`), não do accountId. Fatia 0 só usa
 * `level:account`, então stampar o accountId aqui é correto por ora.
 */
function mapRow(entityId: string, level: EntityLevel, row: MetaInsightRow): InsightRow {
  return {
    entityId,
    level,
    metrics: {
      spend: toNumber(row.spend),
      impressions: toNumber(row.impressions),
      clicks: toNumber(row.clicks),
      ctr: toNumber(row.ctr),
      cpc: toNumber(row.cpc),
      cpm: toNumber(row.cpm),
    },
  };
}

/**
 * Insights via **async report jobs** da Meta (§7):
 *   POST .../insights?async=true → { report_run_id }
 *   poll GET /{report_run_id} até async_status = "Job Completed"
 *   GET /{report_run_id}/insights → linhas paginadas
 *
 * Evita timeouts em janelas grandes e é amigável ao rate-limit.
 */

export type AsyncReportStatus =
  | "Job Not Started"
  | "Job Started"
  | "Job Running"
  | "Job Completed"
  | "Job Failed"
  | "Job Skipped";

export interface ReportRun {
  readonly reportRunId: string;
  readonly status: AsyncReportStatus;
  readonly percentComplete: number;
}

export interface PollOptions {
  readonly maxAttempts?: number;
  readonly intervalMs?: number;
}

export class MetaInsightsService {
  private readonly client: MetaGraphClient;

  constructor(client: MetaGraphClient) {
    this.client = client;
  }

  /**
   * Fatia 0: GET **síncrono** de insights (query pequena → sem report job async).
   * `window` é tratado como `date_preset` (ex: last_7d); time_range/async = fatia 2a.
   */
  async getInsights(query: InsightsQuery): Promise<InsightRow[]> {
    const accountId = normalizeAdAccountId(query.account.adAccountId);
    const res = await this.client.request<{ data?: MetaInsightRow[] }>({
      method: "GET",
      path: `${accountId}/insights`,
      accessToken: query.account.accessToken,
      params: {
        level: query.level,
        fields: query.fields.join(","),
        date_preset: query.window,
      },
    });
    return (res.data.data ?? []).map((row) => mapRow(accountId, query.level, row));
  }

  /** Submete o job assíncrono e retorna o report_run_id. */
  submitReport(query: InsightsQuery): Promise<string> {
    // TODO: POST act_{id}/insights com level/fields/time_range/time_increment + async.
    throw new Error("not implemented");
  }

  /** Faz poll do status até completar (ou falhar/estourar tentativas). */
  pollReport(reportRunId: string, accessToken: string, opts?: PollOptions): Promise<ReportRun> {
    // TODO: GET /{report_run_id}; parar em Completed; erro tipado em Failed/Skipped.
    throw new Error("not implemented");
  }

  /** Busca as linhas do relatório concluído (com paginação). */
  fetchReportRows(reportRunId: string, accessToken: string): Promise<InsightRow[]> {
    // TODO: GET /{report_run_id}/insights, seguir paging.next, mapear métricas.
    throw new Error("not implemented");
  }
}
