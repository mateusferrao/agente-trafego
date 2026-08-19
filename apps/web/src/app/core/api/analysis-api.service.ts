import { Injectable } from '@angular/core';
import type { Observable } from 'rxjs';
import { BaseApiService } from './base-api.service';
import { silentApiContext } from './api-request.interceptor';
import type {
  AgentConfigInput,
  AgentSummary,
  AvailableConversionsOutput,
  CampaignAnalysesOutput,
  FeedbackInput,
  FeedbackOutput,
  LatestRunOutput,
  MuteCampaignInput,
  MutedCampaignsOutput,
  RunDetailOutput,
  RunListOutput,
  SetPausedInput,
  TriggerRunOutput,
} from './generated';

/** Filtros do histórico de análises (todos opcionais). */
export interface ListRunsOptions {
  readonly grades?: readonly string[];
  readonly since?: string;
  readonly until?: string;
  readonly limit?: number;
  readonly offset?: number;
}

/**
 * Endpoints da análise on-demand (3a): agente/meta por conta + disparar run +
 * ler o último resultado. Account-centric (o web conhece a conta, não o agentId).
 */
@Injectable({ providedIn: 'root' })
export class AnalysisApiService extends BaseApiService {
  /** `GET /api/accounts/:id/agent` — agente da conta (cria default se não existir). */
  getAgent(accountId: string): Observable<AgentSummary> {
    return this.get<AgentSummary>(['/accounts', accountId, 'agent']);
  }

  /** `PUT /api/accounts/:id/agent/config` — salva meta+conversão + personalização por texto. */
  saveConfig(accountId: string, input: AgentConfigInput): Observable<AgentSummary> {
    return this.put<AgentSummary, AgentConfigInput>(['/accounts', accountId, 'agent', 'config'], input);
  }

  /**
   * `GET /api/accounts/:id/available-conversions` — conversões que a conta reportou
   * (base do select anotado). Silencioso: falha degrada sem toast (lista vazia).
   */
  availableConversions(accountId: string): Observable<AvailableConversionsOutput> {
    return this.get<AvailableConversionsOutput>(['/accounts', accountId, 'available-conversions'], {
      context: silentApiContext(),
    });
  }

  /** `PUT /api/accounts/:id/agent/paused` — pausa/retoma as análises automáticas. */
  setPaused(accountId: string, paused: boolean): Observable<AgentSummary> {
    return this.put<AgentSummary, SetPausedInput>(['/accounts', accountId, 'agent', 'paused'], {
      paused,
    });
  }

  /** `POST /api/accounts/:id/runs` — dispara "Analisar agora". */
  triggerRun(accountId: string): Observable<TriggerRunOutput> {
    return this.post<TriggerRunOutput, Record<string, never>>(['/accounts', accountId, 'runs'], {});
  }

  /** `GET /api/accounts/:id/runs/latest` — último run + recomendações. */
  latestRun(accountId: string): Observable<LatestRunOutput> {
    return this.get<LatestRunOutput>(['/accounts', accountId, 'runs', 'latest']);
  }

  /**
   * `GET /api/accounts/:id/campaign-analyses` — recorte por campanha do resultado.
   * Silencioso (recorte secundário): falha degrada sem toast (a página zera a lista).
   */
  campaignAnalyses(accountId: string): Observable<CampaignAnalysesOutput> {
    return this.get<CampaignAnalysesOutput>(['/accounts', accountId, 'campaign-analyses'], {
      context: silentApiContext(),
    });
  }

  /** `POST /api/accounts/:id/muted-campaigns` — silencia uma campanha. */
  muteCampaign(accountId: string, externalId: string): Observable<MutedCampaignsOutput> {
    return this.post<MutedCampaignsOutput, MuteCampaignInput>(
      ['/accounts', accountId, 'muted-campaigns'],
      { externalId },
    );
  }

  /** `DELETE /api/accounts/:id/muted-campaigns/:externalId` — reativa a campanha. */
  unmuteCampaign(accountId: string, externalId: string): Observable<MutedCampaignsOutput> {
    return this.delete<MutedCampaignsOutput>(['/accounts', accountId, 'muted-campaigns', externalId]);
  }

  /**
   * `GET /api/accounts/:id/runs` — histórico de análises (lista paginada + filtros).
   * Silencioso (secundário): falha degrada sem toast (a página zera a lista).
   */
  listRuns(accountId: string, opts: ListRunsOptions = {}): Observable<RunListOutput> {
    const grades = opts.grades && opts.grades.length > 0 ? opts.grades.join(',') : undefined;
    return this.get<RunListOutput>(['/accounts', accountId, 'runs'], {
      context: silentApiContext(),
      params: {
        grades,
        since: opts.since,
        until: opts.until,
        limit: opts.limit,
        offset: opts.offset,
      },
    });
  }

  /** `GET /api/accounts/:id/runs/:runId` — detalhe de um run (run + recomendações + campanhas). */
  runDetail(accountId: string, runId: string): Observable<RunDetailOutput> {
    return this.get<RunDetailOutput>(['/accounts', accountId, 'runs', runId]);
  }

  /** `POST /api/recommendations/:id/feedback` — 👍/👎 (👎 vira memória do agente). */
  sendFeedback(recommendationId: string, vote: FeedbackInput['vote']): Observable<FeedbackOutput> {
    return this.post<FeedbackOutput, FeedbackInput>(
      ['/recommendations', recommendationId, 'feedback'],
      { vote },
    );
  }
}
