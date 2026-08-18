import type { InsightRow } from "@trafego/shared/types";
import type { InsightsQuery } from "@trafego/shared/ports";
import type { MetaGraphClient } from "./client.js";

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

  /** Executa o fluxo completo: submit → poll → fetch → mapeia p/ InsightRow. */
  async getInsights(query: InsightsQuery): Promise<InsightRow[]> {
    // TODO: orquestrar submitReport → pollReport → fetchReportRows → mapRows.
    throw new Error("not implemented");
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
