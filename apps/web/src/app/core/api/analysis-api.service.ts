import { Injectable } from '@angular/core';
import type { Observable } from 'rxjs';
import { BaseApiService } from './base-api.service';
import type {
  AgentGoalsInput,
  AgentSummary,
  LatestRunOutput,
  TriggerRunOutput,
} from './generated';

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

  /** `PUT /api/accounts/:id/agent/goals` — atualiza a meta (CPA/ROAS). */
  updateGoals(accountId: string, goals: AgentGoalsInput): Observable<AgentSummary> {
    return this.put<AgentSummary, AgentGoalsInput>(['/accounts', accountId, 'agent', 'goals'], goals);
  }

  /** `POST /api/accounts/:id/runs` — dispara "Analisar agora". */
  triggerRun(accountId: string): Observable<TriggerRunOutput> {
    return this.post<TriggerRunOutput, Record<string, never>>(['/accounts', accountId, 'runs'], {});
  }

  /** `GET /api/accounts/:id/runs/latest` — último run + recomendações. */
  latestRun(accountId: string): Observable<LatestRunOutput> {
    return this.get<LatestRunOutput>(['/accounts', accountId, 'runs', 'latest']);
  }
}
