import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { heroClock } from '@ng-icons/heroicons/outline';
import { UiButton } from '@ui';
import { AuthStore } from '@core/auth';

/**
 * Muro "acesso pendente" (gate de beta, 6b): usuário autenticado e verificado, mas
 * ainda não liberado. Estado de espera amigável (não erro) + próximo passo claro.
 */
@Component({
  selector: 'app-pending-access-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [NgIcon, UiButton],
  providers: [provideIcons({ heroClock })],
  template: `
    <main class="flex min-h-dvh items-center justify-center bg-app p-6">
      <section class="flex max-w-md flex-col items-center gap-4 rounded-lg border border-line bg-panel p-8 text-center shadow-card">
        <span class="flex h-12 w-12 items-center justify-center rounded-full bg-accent-soft text-accent-strong">
          <ng-icon name="heroClock" size="24" aria-hidden="true" />
        </span>
        <h1 class="font-brand text-xl font-bold text-ink">Sua conta está em análise</h1>
        <p class="text-sm text-muted">
          Estamos no beta e liberamos o acesso aos poucos. Avisaremos por email
          @if (email(); as e) {
            (<span class="text-ink">{{ e }}</span>)
          }
          assim que sua conta for liberada.
        </p>
        <button appButton variant="secondary" type="button" [disabled]="loggingOut()" (click)="logout()">
          Sair
        </button>
      </section>
    </main>
  `,
})
export class PendingAccessPage {
  private readonly authStore = inject(AuthStore);
  private readonly router = inject(Router);

  protected readonly loggingOut = signal(false);
  protected readonly email = computed(() => this.authStore.user()?.email ?? null);

  protected logout(): void {
    this.loggingOut.set(true);
    this.authStore.logout().subscribe({
      next: () => void this.router.navigateByUrl('/login'),
      error: () => void this.router.navigateByUrl('/login'),
    });
  }
}
