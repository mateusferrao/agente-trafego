import { Injectable } from '@angular/core';
import type { Observable } from 'rxjs';
import { BaseApiService, silentApiContext } from '../api';
import type {
  EmailCodeRequestInput,
  EmailCodeVerifyInput,
  ForgotPasswordInput,
  LoginInput,
  MeOutput,
  ResetPasswordInput,
  SignupInput,
  SignupOutput,
} from '../api';

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

  /** `POST /api/auth/signup` (6b). NÃO autentica — retorna pendingVerification. */
  signup(body: SignupInput): Observable<SignupOutput> {
    return this.post<SignupOutput, SignupInput>('signup', body, { context: silentApiContext() });
  }

  /** `POST /api/auth/email-code/request` — reenvia o código (sempre 204). */
  requestEmailCode(body: EmailCodeRequestInput): Observable<void> {
    return this.post<void, EmailCodeRequestInput>('email-code/request', body, {
      context: silentApiContext(),
    });
  }

  /** `POST /api/auth/email-code/verify` — confirma o email e cria a sessão. */
  verifyEmailCode(body: EmailCodeVerifyInput): Observable<MeOutput> {
    return this.post<MeOutput, EmailCodeVerifyInput>('email-code/verify', body, {
      context: silentApiContext(),
    });
  }

  /** `POST /api/auth/forgot-password` — pede o link (sempre 204). */
  forgotPassword(body: ForgotPasswordInput): Observable<void> {
    return this.post<void, ForgotPasswordInput>('forgot-password', body, {
      context: silentApiContext(),
    });
  }

  /** `POST /api/auth/reset-password` — aplica a nova senha via token do link. */
  resetPassword(body: ResetPasswordInput): Observable<void> {
    return this.post<void, ResetPasswordInput>('reset-password', body, {
      context: silentApiContext(),
    });
  }

  /** `POST /api/auth/logout`. */
  logout(): Observable<{ ok: boolean }> {
    return this.post<{ ok: boolean }, Record<string, never>>('logout', {});
  }
}
