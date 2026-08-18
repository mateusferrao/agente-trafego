import { Injectable } from '@angular/core';
import type { Observable } from 'rxjs';
import { BaseApiService, silentApiContext } from '../api';
import type { LoginInput, MeOutput, SignupInput } from '../api';

/** Wrapper tipado dos endpoints de auth (`/api/auth/*`). Ver contrato em CLAUDE.md §. */
@Injectable({ providedIn: 'root' })
export class AuthApiService extends BaseApiService {
  protected override readonly resourcePath = '/auth';

  /** `GET /api/auth/me` — fonte de verdade do estado de sessão. 401 = anônimo.
   *  Silencioso: o 401 aqui é esperado (visitante), não deve virar toast. */
  me(): Observable<MeOutput> {
    return this.get<MeOutput>('me', { context: silentApiContext() });
  }

  /** `POST /api/auth/login`. Silencioso: erro de credencial vira mensagem inline no form. */
  login(body: LoginInput): Observable<MeOutput> {
    return this.post<MeOutput, LoginInput>('login', body, { context: silentApiContext() });
  }

  /** `POST /api/auth/signup`. Silencioso: erros de validação viram mensagem inline no form. */
  signup(body: SignupInput): Observable<MeOutput> {
    return this.post<MeOutput, SignupInput>('signup', body, { context: silentApiContext() });
  }

  /** `POST /api/auth/logout`. */
  logout(): Observable<{ ok: boolean }> {
    return this.post<{ ok: boolean }, Record<string, never>>('logout', {});
  }
}
