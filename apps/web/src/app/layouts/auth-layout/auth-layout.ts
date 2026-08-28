import { ChangeDetectionStrategy, Component } from '@angular/core';
import { RouterOutlet } from '@angular/router';

/**
 * Casca das telas públicas (login/signup). Full-screen, centrada, com a marca no
 * topo. O conteúdo (card do form) vem pelo router-outlet. Superfície calma,
 * light+dark (DESIGN.md §4).
 */
@Component({
  selector: 'app-auth-layout',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterOutlet],
  template: `
    <main class="flex min-h-dvh flex-col items-center justify-center gap-8 px-4 py-10">
      <div class="brand-lockup">
        <span class="brand-mark" aria-hidden="true"></span>
        <span class="brand-wordmark text-lg">CaquiAI</span>
      </div>

      <div class="w-full max-w-sm">
        <router-outlet />
      </div>
    </main>
  `,
})
export class AuthLayoutComponent {}
