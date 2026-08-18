import { computed, inject, Injectable, signal } from '@angular/core';
import { catchError, finalize, map, of, tap } from 'rxjs';
import type { Observable } from 'rxjs';
import type { LoginInput, MeOutput, SignupInput } from '../api';
import { AuthApiService } from './auth-api.service';

/**
 * Estado de sessão do lado do cliente (signals). Fonte de verdade = `GET /api/auth/me`
 * (o cookie é HttpOnly; nunca lido em JS — CLAUDE.md §12). Bootstrap idempotente:
 * `ensureSession()` chama `/me` uma vez e memoriza (401 = anônimo).
 */
@Injectable({ providedIn: 'root' })
export class AuthStore {
  private readonly authApi = inject(AuthApiService);

  private readonly meSignal = signal<MeOutput | null>(null);
  private readonly checkedSignal = signal(false);
  private readonly loadingSignal = signal(false);

  /** MeOutput atual (ou null se anônimo). */
  readonly me = this.meSignal.asReadonly();
  /** true depois que o primeiro `/me` resolveu (evita flicker de guard). */
  readonly checked = this.checkedSignal.asReadonly();
  readonly isLoading = this.loadingSignal.asReadonly();

  readonly isAuthenticated = computed(() => this.meSignal() !== null);
  /** Alias de conveniência para telas (perfil/settings). */
  readonly user = computed(() => this.meSignal());
  readonly orgName = computed(() => this.meSignal()?.orgName ?? null);
  readonly role = computed(() => this.meSignal()?.role ?? null);
  readonly accessStatus = computed(() => this.meSignal()?.accessStatus ?? null);

  /** Carrega (ou recarrega) a sessão a partir de `/me`. 401 → anônimo (null). */
  loadSession(): Observable<MeOutput | null> {
    this.loadingSignal.set(true);
    return this.authApi.me().pipe(
      map((me) => me as MeOutput | null),
      catchError(() => of(null)),
      tap((me) => this.meSignal.set(me)),
      finalize(() => {
        this.checkedSignal.set(true);
        this.loadingSignal.set(false);
      }),
    );
  }

  /** Resolve o estado de auth uma única vez (usado pelos guards). */
  ensureSession(): Observable<boolean> {
    if (this.checkedSignal()) {
      return of(this.isAuthenticated());
    }
    return this.loadSession().pipe(map((me) => me !== null));
  }

  login(body: LoginInput): Observable<MeOutput> {
    this.loadingSignal.set(true);
    return this.authApi.login(body).pipe(
      tap((me) => this.applySession(me)),
      finalize(() => this.loadingSignal.set(false)),
    );
  }

  signup(body: SignupInput): Observable<MeOutput> {
    this.loadingSignal.set(true);
    return this.authApi.signup(body).pipe(
      tap((me) => this.applySession(me)),
      finalize(() => this.loadingSignal.set(false)),
    );
  }

  logout(): Observable<void> {
    // Logout é best-effort: a sessão local é SEMPRE limpa, mesmo se a chamada ao
    // servidor falhar (offline/erro) — senão o guestOnlyGuard rebateria o usuário
    // de volta ao shell. O servidor revoga a sessão quando alcançável.
    return this.authApi.logout().pipe(
      catchError(() => of(undefined)),
      tap(() => this.applySession(null)),
      map(() => undefined),
    );
  }

  /** Reflete um novo nome de org na sessão local (após renomear em Configurações). */
  setOrgName(orgName: string): void {
    const me = this.meSignal();
    if (me) {
      this.meSignal.set({ ...me, orgName });
    }
  }

  private applySession(me: MeOutput | null): void {
    this.meSignal.set(me);
    this.checkedSignal.set(true);
  }
}
