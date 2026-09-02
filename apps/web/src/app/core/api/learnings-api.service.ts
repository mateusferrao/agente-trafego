import { Injectable } from '@angular/core';
import type { Observable } from 'rxjs';
import { BaseApiService } from './base-api.service';
import { silentApiContext } from './api-request.interceptor';
import type { EditLearningInput, LearningOk, LearningsList } from './generated';

/**
 * Endpoints do aprendizado contínuo (aba "Aprendizados"). Listar + editar/confirmar/
 * esquecer (S5). Keyed por agentId (a página resolve pelo agente da conta).
 */
@Injectable({ providedIn: 'root' })
export class LearningsApiService extends BaseApiService {
  /** `GET /api/agents/:agentId/learnings` — lições curadas do agente. */
  list(agentId: string, opts?: { silent?: boolean }): Observable<LearningsList> {
    return this.get<LearningsList>(
      ['/agents', agentId, 'learnings'],
      opts?.silent ? { context: silentApiContext() } : undefined,
    );
  }

  /** `PATCH /api/agents/:agentId/learnings/:id` — reescreve a frase. */
  edit(agentId: string, id: string, input: EditLearningInput): Observable<LearningOk> {
    return this.patch<LearningOk, EditLearningInput>(['/agents', agentId, 'learnings', id], input);
  }

  /** `POST /api/agents/:agentId/learnings/:id/confirm` — confirma (sobe confiança). */
  confirm(agentId: string, id: string): Observable<LearningOk> {
    return this.post<LearningOk, undefined>(['/agents', agentId, 'learnings', id, 'confirm'], undefined);
  }

  /** `DELETE /api/agents/:agentId/learnings/:id` — esquece (arquiva). */
  forget(agentId: string, id: string): Observable<LearningOk> {
    return this.delete<LearningOk>(['/agents', agentId, 'learnings', id]);
  }

  /** `POST /api/agents/:agentId/learnings/:id/accept-threshold` — aplica o ajuste de comportamento. */
  acceptThreshold(agentId: string, id: string): Observable<LearningOk> {
    return this.post<LearningOk, undefined>(['/agents', agentId, 'learnings', id, 'accept-threshold'], undefined);
  }
}
