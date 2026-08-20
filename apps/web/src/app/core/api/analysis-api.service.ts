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
  LastRunActionsOutput,
  LatestRunOutput,
  MuteCampaignInput,
  MutedCampaignsOutput,
  OkOutput,
  PlaybookRuleInput,
  PlaybookRuleOutput,
  PlaybookRulesOutput,
  ReseedArchetypeInput,
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
  /** `GET /api/accounts/:id/agent` — agente da conta (cria default se não existir).
   *  `silent` p/ chamadas secundárias (seções que já têm o dado na página-mãe) não
   *  duplicarem toast de erro. */
  getAgent(accountId: string, opts?: { silent?: boolean }): Observable<AgentSummary> {
    return this.get<AgentSummary>(
      ['/accounts', accountId, 'agent'],
      opts?.silent ? { context: silentApiContext() } : undefined,
    );
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

  /** `PUT /api/accounts/:id/agent/archetype` — re-semeia o arquétipo (reseta comportamento). */
  reseedArchetype(accountId: string, archetype: string): Observable<AgentSummary> {
    return this.put<AgentSummary, ReseedArchetypeInput>(
      ['/accounts', accountId, 'agent', 'archetype'],
      { archetype },
    );
  }

  /** `GET /api/accounts/:id/agent/playbook-rules` — regras de playbook do agente. */
  listPlaybookRules(accountId: string): Observable<PlaybookRulesOutput> {
    return this.get<PlaybookRulesOutput>(['/accounts', accountId, 'agent', 'playbook-rules']);
  }

  /** `POST /api/accounts/:id/agent/playbook-rules` — cria uma regra. */
  createPlaybookRule(accountId: string, input: PlaybookRuleInput): Observable<PlaybookRuleOutput> {
    return this.post<PlaybookRuleOutput, PlaybookRuleInput>(
      ['/accounts', accountId, 'agent', 'playbook-rules'],
      input,
    );
  }

  /** `PUT /api/accounts/:id/agent/playbook-rules/:ruleId` — atualiza uma regra. */
  updatePlaybookRule(
    accountId: string,
    ruleId: string,
    input: PlaybookRuleInput,
  ): Observable<PlaybookRuleOutput> {
    return this.put<PlaybookRuleOutput, PlaybookRuleInput>(
      ['/accounts', accountId, 'agent', 'playbook-rules', ruleId],
      input,
    );
  }

  /** `DELETE /api/accounts/:id/agent/playbook-rules/:ruleId` — remove uma regra. */
  deletePlaybookRule(accountId: string, ruleId: string): Observable<OkOutput> {
    return this.delete<OkOutput>(['/accounts', accountId, 'agent', 'playbook-rules', ruleId]);
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

  /** `GET /api/accounts/:id/agent/actions/last-run` — ações aplicadas + sugeridas do último run. */
  lastRunActions(accountId: string): Observable<LastRunActionsOutput> {
    return this.get<LastRunActionsOutput>(['/accounts', accountId, 'agent', 'actions', 'last-run'], {
      context: silentApiContext(),
    });
  }

  /** `POST /api/accounts/:id/agent/actions/:toolCallId/undo` — pede o undo de uma ação. */
  undoAction(accountId: string, toolCallId: string): Observable<OkOutput> {
    return this.post<OkOutput, Record<string, never>>(
      ['/accounts', accountId, 'agent', 'actions', toolCallId, 'undo'],
      {},
    );
  }
}
