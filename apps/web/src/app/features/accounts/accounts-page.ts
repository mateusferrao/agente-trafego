import { ChangeDetectionStrategy, Component, DestroyRef, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { provideIcons } from '@ng-icons/core';
import { heroBuildingOffice2 } from '@ng-icons/heroicons/outline';
import { UiButton, UiEmptyState, UiPageHeader, UiSpinner } from '@ui';
import { DashboardApiService } from '@core/api/dashboard-api.service';
import { AccountPanoramaCard, type PanoramaCardVm } from '../../shared/account-panorama-card';

const RELOAD_MS = 5000;

/**
 * Contas = roster INFORMATIVO das contas sob gestão (mesmos cards de decisão do
 * Painel, via panorama: nota datada + KPIs ao vivo + as-of + Atualizar). A conexão e
 * a escolha de quais contas entram acontecem em Integrações. Estados: carregando /
 * erro / vazio (CTA → Integrações) / lista rica.
 */
@Component({
  selector: 'app-accounts-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [UiButton, UiEmptyState, UiPageHeader, UiSpinner, AccountPanoramaCard],
  providers: [provideIcons({ heroBuildingOffice2 })],
  template: `
    <div class="flex flex-col gap-8">
      <app-ui-page-header title="Contas" subtitle="Contas de anúncio sob gestão e seus agentes.">
        @if ((cards()?.length ?? 0) > 0) {
          <button appButton variant="primary" type="button" actions (click)="goToIntegrations()">
            Conectar em Integrações
          </button>
        }
      </app-ui-page-header>

      @if (cards() === null && !loadFailed()) {
        <div class="flex items-center justify-center gap-3 rounded-lg border border-line bg-panel p-10 text-sm text-muted">
          <app-ui-spinner [size]="20" [stroke]="2" aria-hidden="true" />
          Carregando suas contas…
        </div>
      } @else if (loadFailed()) {
        <div class="flex flex-col items-start gap-3 rounded-lg border border-line bg-panel p-6">
          <p class="text-sm text-ink">Não consegui carregar suas contas agora.</p>
          <button appButton variant="secondary" type="button" (click)="reload()">Tentar de novo</button>
        </div>
      } @else if ((cards()?.length ?? 0) === 0) {
        <app-ui-empty-state
          icon="heroBuildingOffice2"
          title="Nenhuma conta sob gestão ainda"
          description="Conecte sua conta Meta em Integrações e escolha quais contas o agente vai acompanhar."
        >
          <button appButton variant="primary" type="button" actions (click)="goToIntegrations()">
            Ir para Integrações
          </button>
        </app-ui-empty-state>
      } @else {
        <div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          @for (c of cards() ?? []; track c.accountId) {
            <app-account-panorama-card
              [card]="c"
              [refreshing]="refreshing().has(c.accountId)"
              (refresh)="refreshAccount($event)"
            />
          }
        </div>
      }
    </div>
  `,
})
export class AccountsPage {
  private readonly api = inject(DashboardApiService);
  private readonly router = inject(Router);

  protected readonly cards = signal<PanoramaCardVm[] | null>(null);
  protected readonly loadFailed = signal(false);
  protected readonly refreshing = signal<ReadonlySet<string>>(new Set());
  private destroyed = false;

  constructor() {
    inject(DestroyRef).onDestroy(() => (this.destroyed = true));
    this.reload();
  }

  protected goToIntegrations(): void {
    void this.router.navigate(['/integrations']);
  }

  protected reload(): void {
    this.loadFailed.set(false);
    this.cards.set(null);
    this.api.panorama().subscribe({
      next: (out) => this.cards.set(out.accounts),
      error: () => {
        this.cards.set([]);
        this.loadFailed.set(true);
      },
    });
  }

  /** "Atualizar" no card: força sync-only + recarrega a lista após o sync (bounded). */
  protected refreshAccount(id: string): void {
    if (this.refreshing().has(id)) return;
    this.refreshing.update((s) => new Set(s).add(id));
    this.api.refreshData(id).subscribe({
      next: () =>
        setTimeout(() => {
          if (this.destroyed) return;
          this.api.panorama().subscribe({ next: (out) => this.cards.set(out.accounts), error: () => {} });
          this.clearRefreshing(id);
        }, RELOAD_MS),
      error: () => this.clearRefreshing(id),
    });
  }

  private clearRefreshing(id: string): void {
    this.refreshing.update((s) => {
      const next = new Set(s);
      next.delete(id);
      return next;
    });
  }
}
