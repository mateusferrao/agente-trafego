import type {
  ConversionCount,
  EntityLevel,
  InsightMetrics,
  InsightRow,
} from "@trafego/shared/types";
import type { InsightsQuery } from "@trafego/shared/ports";
import {
  META_TRANSIENT_CODES,
  MetaApiError,
  type BusinessUseCaseUsage,
  type GraphRequest,
  type GraphResponse,
  type MetaGraphClient,
} from "./client.js";
import type { MetaGovernor } from "./governor.js";
import { parseActionType } from "./meta-conversion-map.js";

const AD_ACCOUNT_PREFIX = "act_";
// Poll do relatório assíncrono.
const DEFAULT_POLL_MAX_ATTEMPTS = 30;
const DEFAULT_POLL_INTERVAL_MS = 2000;
// Re-submissões frescas em falha transitória/report Failed/Skipped.
const MAX_RESUBMIT = 2;
// Paginação do resultado do relatório.
const REPORT_PAGE_LIMIT = 500;
const MAX_REPORT_PAGES = 100;
// Erro "dados-por-chamada grandes demais" → estreitar a janela.
const TOO_LARGE_CODE = 100;
const TOO_LARGE_SUBCODE = 1487534;
const MS_PER_DAY = 86_400_000;
const RANGE_RE = /^(\d{4}-\d{2}-\d{2})\.\.(\d{4}-\d{2}-\d{2})$/;

/** Uma entrada de `actions`/`action_values` da Meta (array por action_type). */
interface MetaActionStat {
  readonly action_type: string;
  readonly value?: string;
}

/** Linha crua de insights da Meta (escalares como string; conversões como arrays). */
interface MetaInsightRow {
  readonly account_id?: string;
  readonly campaign_id?: string;
  readonly adset_id?: string;
  readonly ad_id?: string;
  readonly id?: string;
  readonly date_start?: string;
  readonly spend?: string;
  readonly impressions?: string;
  readonly clicks?: string;
  readonly ctr?: string;
  readonly cpc?: string;
  readonly cpm?: string;
  readonly frequency?: string;
  readonly actions?: MetaActionStat[];
  readonly action_values?: MetaActionStat[];
  readonly [key: string]: unknown;
}

interface ReportResultPage {
  readonly data?: MetaInsightRow[];
  readonly paging?: { readonly next?: string; readonly cursors?: { readonly after?: string } };
}

function normalizeAdAccountId(id: string): string {
  return id.startsWith(AD_ACCOUNT_PREFIX) ? id : `${AD_ACCOUNT_PREFIX}${id}`;
}

function toNumber(value: unknown): number {
  const n = typeof value === "string" ? Number(value) : typeof value === "number" ? value : NaN;
  return Number.isFinite(n) ? n : 0;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** id da entidade a partir do id do próprio nível da linha (não do accountId). */
function entityIdForLevel(row: MetaInsightRow, level: EntityLevel, accountFallback: string): string {
  switch (level) {
    case "campaign":
      return row.campaign_id ?? row.id ?? accountFallback;
    case "adset":
      return row.adset_id ?? row.id ?? accountFallback;
    case "ad":
      return row.ad_id ?? row.id ?? accountFallback;
    case "account":
    default:
      return row.account_id ? normalizeAdAccountId(row.account_id) : accountFallback;
  }
}

/**
 * Normaliza o array cru `actions` (+ `action_values` p/ ROAS) → breakdown genérico
 * de conversão + um mapa cru opaco p/ auditoria. Ações não-conversão (link_click…)
 * ficam só no mapa cru; conversões desconhecidas caem no balde `custom` (não descarta).
 */
function buildConversions(row: MetaInsightRow): {
  conversions?: ConversionCount[];
  rawActions?: Record<string, number>;
} {
  const actions = row.actions ?? [];
  if (actions.length === 0) return {};

  const valueByType = new Map<string, number>();
  for (const av of row.action_values ?? []) valueByType.set(av.action_type, toNumber(av.value));

  const conversions: ConversionCount[] = [];
  const rawActions: Record<string, number> = {};
  for (const a of actions) {
    const count = toNumber(a.value);
    rawActions[a.action_type] = count;
    const parsed = parseActionType(a.action_type);
    if (!parsed) continue;
    const value = valueByType.get(a.action_type);
    conversions.push({
      goal: parsed.goal,
      ...(parsed.customConversionId ? { customConversionId: parsed.customConversionId } : {}),
      count,
      ...(value !== undefined ? { value } : {}),
    });
  }
  return {
    ...(conversions.length ? { conversions } : {}),
    ...(Object.keys(rawActions).length ? { rawActions } : {}),
  };
}

function mapRow(level: EntityLevel, row: MetaInsightRow, accountFallback: string): InsightRow {
  const metrics: InsightMetrics = {
    spend: toNumber(row.spend),
    impressions: toNumber(row.impressions),
    clicks: toNumber(row.clicks),
    ctr: toNumber(row.ctr),
    cpc: toNumber(row.cpc),
    cpm: toNumber(row.cpm),
    ...(row.frequency !== undefined ? { frequency: toNumber(row.frequency) } : {}),
  };
  return {
    entityId: entityIdForLevel(row, level, accountFallback),
    level,
    ...(row.date_start ? { date: row.date_start } : {}),
    metrics,
    ...buildConversions(row),
  };
}

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

/**
 * Insights via **async report jobs** (§7): POST `.../insights` (o verbo POST torna
 * async) → `report_run_id`; poll `GET /{id}` até `Job Completed`+100% (Failed/Skipped
 * = terminal, re-submete fresh); `GET /{id}/insights` paginado. Fixa
 * `use_unified_attribution_setting` p/ comparabilidade. Envolvido pelo governor.
 */
export class MetaInsightsService {
  private readonly client: MetaGraphClient;
  private readonly governor: MetaGovernor;
  private readonly pollOptions: PollOptions;

  constructor(client: MetaGraphClient, governor: MetaGovernor, pollOptions: PollOptions = {}) {
    this.client = client;
    this.governor = governor;
    this.pollOptions = pollOptions;
  }

  async getInsights(query: InsightsQuery): Promise<InsightRow[]> {
    const accountId = normalizeAdAccountId(query.account.adAccountId);
    const acquired = await this.governor.acquire(accountId);
    if (!acquired.granted) {
      // cooldown ativo → sinaliza transiente (o adapter mapeia p/ upstream = degradação)
      throw new MetaApiError("rate-limit: cooldown ativo", 80000, undefined, 429);
    }
    return this.runReport(query, 0);
  }

  /** submit → poll → fetch, com re-submissão fresh em falha transitória. */
  private async runReport(query: InsightsQuery, resubmit: number): Promise<InsightRow[]> {
    const accountId = normalizeAdAccountId(query.account.adAccountId);
    try {
      const runId = await this.submitReport(query);
      await this.pollReport(runId, query.account.accessToken, accountId);
      return await this.fetchReportRows(runId, query);
    } catch (error) {
      if (isTooLarge(error)) return this.splitAndFetch(query);
      if (isRetryable(error) && resubmit < MAX_RESUBMIT) {
        await sleep(this.governor.backoffDelayMs(resubmit));
        return this.runReport(query, resubmit + 1);
      }
      throw error;
    }
  }

  /** Divide a janela ao meio e busca cada metade (contorno do 1487534). */
  private async splitAndFetch(query: InsightsQuery): Promise<InsightRow[]> {
    const range = parseRange(query.window);
    if (!range || range.since === range.until) {
      // não dá p/ estreitar: janela é date_preset (não divisível) ou já é 1 dia.
      throw new MetaApiError(
        "dados grandes demais e janela não divisível (date_preset ou já em 1 dia)",
        TOO_LARGE_CODE,
        TOO_LARGE_SUBCODE,
        400,
      );
    }
    const mid = midDate(range.since, range.until);
    const first = { ...query, window: `${range.since}..${mid}` };
    const second = { ...query, window: `${nextDay(mid)}..${range.until}` };
    const [a, b] = [await this.runReport(first, 0), await this.runReport(second, 0)];
    return [...a, ...b];
  }

  /** Submete o job assíncrono (POST) e retorna o report_run_id. */
  async submitReport(query: InsightsQuery): Promise<string> {
    const accountId = normalizeAdAccountId(query.account.adAccountId);
    const res = await this.requestObserving<{ report_run_id?: string }>(accountId, {
      method: "POST",
      path: `${accountId}/insights`,
      accessToken: query.account.accessToken,
      params: {
        level: query.level,
        fields: query.fields.join(","),
        time_increment: query.timeIncrement ?? "1",
        use_unified_attribution_setting: true,
        ...windowParams(query.window),
      },
    });
    const id = res.data.report_run_id;
    if (!id) throw new MetaApiError("submit de relatório sem report_run_id", undefined, undefined, 502);
    return id;
  }

  /**
   * Poll até `Job Completed`+100%; erro tipado em Failed/Skipped e no timeout.
   * Passa pelo `requestObserving` (com `accountId`) p/ alimentar o governor com o
   * uso reportado — o poll é a maior fonte de chamadas, não pode ficar cego.
   */
  async pollReport(
    reportRunId: string,
    accessToken: string,
    accountId: string,
    opts?: PollOptions,
  ): Promise<ReportRun> {
    const maxAttempts = opts?.maxAttempts ?? this.pollOptions.maxAttempts ?? DEFAULT_POLL_MAX_ATTEMPTS;
    const intervalMs = opts?.intervalMs ?? this.pollOptions.intervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const res = await this.requestObserving<{
        async_status?: AsyncReportStatus;
        async_percent_completion?: number;
      }>(accountId, { method: "GET", path: reportRunId, accessToken });
      const status = res.data.async_status ?? "Job Not Started";
      const pct = res.data.async_percent_completion ?? 0;
      if (status === "Job Completed" && pct >= 100) {
        return { reportRunId, status, percentComplete: pct };
      }
      if (status === "Job Failed" || status === "Job Skipped") {
        throw new MetaApiError(`relatório não concluído: ${status}`, undefined, undefined, 500);
      }
      await sleep(intervalMs);
    }
    throw new MetaApiError("timeout aguardando o relatório", undefined, undefined, 504);
  }

  /** Busca as linhas do relatório concluído (paginado) e mapeia. */
  async fetchReportRows(reportRunId: string, query: InsightsQuery): Promise<InsightRow[]> {
    const accountId = normalizeAdAccountId(query.account.adAccountId);
    const rows: InsightRow[] = [];
    let after: string | undefined;
    for (let page = 0; page < MAX_REPORT_PAGES; page++) {
      const res = await this.requestObserving<ReportResultPage>(accountId, {
        method: "GET",
        path: `${reportRunId}/insights`,
        accessToken: query.account.accessToken,
        params: { limit: REPORT_PAGE_LIMIT, ...(after ? { after } : {}) },
      });
      for (const raw of res.data.data ?? []) rows.push(mapRow(query.level, raw, accountId));
      after = res.data.paging?.next ? res.data.paging.cursors?.after : undefined;
      if (!after) break;
    }
    return rows;
  }

  /** Faz a request e alimenta o governor com o uso reportado no header. */
  private async requestObserving<T>(accountId: string, req: GraphRequest): Promise<GraphResponse<T>> {
    const res = await this.client.request<T>(req);
    const usage = pickUsage(res.usage, accountId);
    if (usage) await this.governor.observeUsage(accountId, usage);
    return res;
  }
}

function pickUsage(
  usage: Readonly<Record<string, BusinessUseCaseUsage>> | undefined,
  accountId: string,
): BusinessUseCaseUsage | undefined {
  if (!usage) return undefined;
  return usage[accountId] ?? usage[accountId.replace(AD_ACCOUNT_PREFIX, "")] ?? Object.values(usage)[0];
}

function parseRange(window: string): { since: string; until: string } | null {
  const m = RANGE_RE.exec(window);
  return m ? { since: m[1]!, until: m[2]! } : null;
}

function windowParams(window: string): Record<string, unknown> {
  const range = parseRange(window);
  return range
    ? { time_range: JSON.stringify({ since: range.since, until: range.until }) }
    : { date_preset: window };
}

function isRetryable(error: unknown): boolean {
  return (
    error instanceof MetaApiError &&
    (error.httpStatus >= 500 || (error.code !== undefined && META_TRANSIENT_CODES.has(error.code)))
  );
}

function isTooLarge(error: unknown): boolean {
  return error instanceof MetaApiError && error.code === TOO_LARGE_CODE && error.subcode === TOO_LARGE_SUBCODE;
}

function isoToUtc(iso: string): number {
  const [y, m, d] = iso.split("-").map(Number);
  return Date.UTC(y!, m! - 1, d!);
}

function utcToIso(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function midDate(since: string, until: string): string {
  const days = Math.floor((isoToUtc(until) - isoToUtc(since)) / MS_PER_DAY / 2);
  return utcToIso(isoToUtc(since) + days * MS_PER_DAY);
}

function nextDay(iso: string): string {
  return utcToIso(isoToUtc(iso) + MS_PER_DAY);
}
