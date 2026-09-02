import { Injectable } from '@angular/core';
import type { Observable } from 'rxjs';
import { BaseApiService } from './base-api.service';
import { silentApiContext } from './api-request.interceptor';
import type { LearningsList } from './generated';

/**
 * Endpoints do aprendizado contínuo (aba "Aprendizados"). Read-only na S1
 * (editar/confirmar/esquecer = S5). Keyed por agentId (a página resolve pelo agente da conta).
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
}
