import {
  ApplicationConfig,
  inject,
  provideAppInitializer,
  provideBrowserGlobalErrorListeners,
  provideZonelessChangeDetection,
} from '@angular/core';
import { provideRouter, withComponentInputBinding } from '@angular/router';
import { provideHttpClient, withFetch, withInterceptors } from '@angular/common/http';
import { routes } from './app.routes';
import { apiRequestInterceptor } from '@core/api';
import { authSessionInterceptor } from '@core/auth';
import { ThemeStore } from '@core/theme/theme.store';

// Config raiz da aplicação standalone (Angular 21 + signals, zoneless).
// Interceptors registrados via withInterceptors (funcionais):
//  - apiRequestInterceptor: toast amigável em erro de resposta da API;
//  - authSessionInterceptor: 401 (sessão morta) → limpa sessão e vai p/ /login.
export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideZonelessChangeDetection(),
    provideRouter(routes, withComponentInputBinding()),
    provideHttpClient(
      withFetch(),
      withInterceptors([apiRequestInterceptor, authSessionInterceptor]),
    ),
    // Aplica o tema (claro/escuro/sistema) no boot, antes da primeira pintura.
    provideAppInitializer(() => {
      inject(ThemeStore).apply();
    }),
  ],
};
