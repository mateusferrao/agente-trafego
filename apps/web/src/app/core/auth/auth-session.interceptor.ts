import { HttpErrorResponse } from '@angular/common/http';
import type { HttpEvent, HttpHandlerFn, HttpRequest } from '@angular/common/http';
import { inject } from '@angular/core';
import { Router } from '@angular/router';
import { catchError, throwError } from 'rxjs';
import type { Observable } from 'rxjs';
import { environment } from '../../../environments/environment';
import { AuthStore } from './auth.store';

const AUTH_PATH_PREFIX = `${environment.apiBaseUrl}/auth/`;

/**
 * Ao receber 401 de uma chamada à API (sessão morta), zera a sessão local e manda
 * para `/login`. Exceções: o próprio fluxo de auth (`/api/auth/*` — login/signup/me
 * tratam o 401 inline/silenciosamente) e quando já estamos numa rota de auth.
 */
export function authSessionInterceptor(
  req: HttpRequest<unknown>,
  next: HttpHandlerFn,
): Observable<HttpEvent<unknown>> {
  const router = inject(Router);
  const authStore = inject(AuthStore);

  return next(req).pipe(
    catchError((error: unknown) => {
      if (shouldRedirect(req, error, router)) {
        void authStore.logout().subscribe({ error: () => undefined });
        void router.navigate(['/login'], { queryParams: { returnTo: router.url } });
      } else if (isAccessPending(req, error)) {
        // gate de beta (6b): acesso não liberado → muro (sem deslogar).
        void router.navigateByUrl('/acesso-pendente');
      }
      return throwError(() => error);
    }),
  );
}

/** 403 com code `access_pending` numa chamada de API (gate de beta). */
function isAccessPending(req: HttpRequest<unknown>, error: unknown): boolean {
  return (
    error instanceof HttpErrorResponse &&
    error.status === 403 &&
    req.url.startsWith(environment.apiBaseUrl) &&
    (error.error as { code?: string } | null)?.code === 'access_pending'
  );
}

function shouldRedirect(req: HttpRequest<unknown>, error: unknown, router: Router): boolean {
  return (
    error instanceof HttpErrorResponse &&
    error.status === 401 &&
    req.url.startsWith(environment.apiBaseUrl) &&
    !req.url.startsWith(AUTH_PATH_PREFIX) &&
    !isOnAuthRoute(router.url)
  );
}

function isOnAuthRoute(url: string): boolean {
  return (
    url.startsWith('/login') ||
    url.startsWith('/signup') ||
    url.startsWith('/verify-email') ||
    url.startsWith('/forgot-password') ||
    url.startsWith('/reset-password') ||
    url.startsWith('/acesso-pendente')
  );
}
