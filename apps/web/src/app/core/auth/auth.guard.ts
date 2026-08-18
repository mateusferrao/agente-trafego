import { inject } from '@angular/core';
import { Router } from '@angular/router';
import type { CanActivateFn, RouterStateSnapshot } from '@angular/router';
import { map } from 'rxjs';
import { AuthStore } from './auth.store';

/** Rota autenticada: visitante anônimo → `/login?returnTo=<url>`. */
export const authGuard: CanActivateFn = (_route, state) => {
  const authStore = inject(AuthStore);
  const router = inject(Router);

  return authStore.ensureSession().pipe(
    map((isAuthenticated) => (isAuthenticated ? true : createLoginRedirect(router, state))),
  );
};

/** Rota só-para-visitante (login/signup): usuário logado → shell (ou `returnTo`). */
export const guestOnlyGuard: CanActivateFn = (route) => {
  const authStore = inject(AuthStore);
  const router = inject(Router);

  return authStore.ensureSession().pipe(
    map((isAuthenticated) =>
      isAuthenticated
        ? router.parseUrl(resolveReturnPath(route.queryParamMap.get('returnTo')))
        : true,
    ),
  );
};

function createLoginRedirect(router: Router, state: RouterStateSnapshot) {
  return router.createUrlTree(['/login'], { queryParams: { returnTo: state.url } });
}

/** Só aceita caminhos internos (mesma origem) — evita open-redirect via `returnTo`. */
function resolveReturnPath(value: string | null): string {
  if (!value) {
    return '/';
  }
  try {
    const url = new URL(value, globalThis.location.origin);
    if (url.origin !== globalThis.location.origin) {
      return '/';
    }
    return `${url.pathname}${url.search}${url.hash}` || '/';
  } catch {
    return '/';
  }
}
