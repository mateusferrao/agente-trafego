import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  heroBuildingOffice2,
  heroCheckCircle,
  heroClock,
  heroExclamationTriangle,
} from '@ng-icons/heroicons/outline';
import { UiButton, UiEmptyState, UiPageHeader, UiSpinner } from '@ui';
import { AccountsApiService } from '@core/api/accounts-api.service';
import type { AdAccountOutput, AdAccountOutputTokenStatusEnumKey } from '@core/api/generated';

interface TokenIndicator {
  readonly icon: string;
  /** Classe de cor + layout do ícone. */
  readonly class: string;
  /** Rótulo acessível (aria-label + tooltip) — status nunca depende só de cor/forma. */
  readonly label: string;
}

// Status do token por ÍCONE colorido (forma + cor + rótulo — nunca só cor; DESIGN.md
// color-blind-safe). O token é da conexão; reconectar acontece em Integrações.
const TOKEN_INDICATOR: Record<AdAccountOutputTokenStatusEnumKey, TokenIndicator> = {
  valid: {
    icon: 'heroCheckCircle',
    class: 'inline-flex shrink-0 text-success-strong',
    label: 'Token válido',
  },
  invalid: {
    icon: 'heroExclamationTriangle',
    class: 'inline-flex shrink-0 text-danger-strong',
    label: 'Token expirado — reconecte em Integrações',
  },
  unchecked: {
    icon: 'heroClock',
    class: 'inline-flex shrink-0 text-warning-strong',
    label: 'Token não verificado',
  },
};

/**
 * Contas = landing (/accounts). **Reflete** as contas sob gestão (ativas) — a
 * conexão e a escolha de quais contas entram acontecem em Integrações. Estados:
 * carregando / erro / vazio (CTA → Integrações) / com contas (nome + id + token).
 */
@Component({
  selector: 'app-accounts-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [NgIcon, RouterLink, UiButton, UiEmptyState, UiPageHeader, UiSpinner],
  providers: [
    provideIcons({ heroBuildingOffice2, heroCheckCircle, heroClock, heroExclamationTriangle }),
  ],
  template: `
    <div class="flex flex-col gap-8">
      <app-ui-page-header title="Contas" subtitle="Contas de anúncio sob gestão e seus agentes.">
        @if ((accounts()?.length ?? 0) > 0) {
          <button appButton variant="primary" type="button" actions (click)="goToIntegrations()">
            Conectar em Integrações
          </button>
        }
      </app-ui-page-header>

      @if (accounts() === null && !loadFailed()) {
        <div class="flex items-center justify-center gap-3 rounded-lg border border-line bg-panel p-10 text-sm text-muted">
          <app-ui-spinner [size]="20" [stroke]="2" aria-hidden="true" />
          Carregando suas contas…
        </div>
      } @else if (loadFailed()) {
        <div class="flex flex-col items-start gap-3 rounded-lg border border-line bg-panel p-6">
          <p class="text-sm text-ink">Não consegui carregar suas contas agora.</p>
          <button appButton variant="secondary" type="button" (click)="reload()">Tentar de novo</button>
        </div>
      } @else if ((accounts()?.length ?? 0) === 0) {
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
          @for (account of accounts() ?? []; track account.id) {
            <a
              [routerLink]="['/accounts', account.id]"
              class="flex items-start justify-between gap-3 rounded-lg border border-line bg-panel p-5 transition-colors hover:bg-soft"
            >
              <div class="flex min-w-0 flex-col gap-0.5">
                <h2 class="truncate font-brand text-base font-semibold text-ink">
                  {{ account.name ?? account.adAccountId }}
                </h2>
                <p class="truncate text-xs text-muted">
                  Conta {{ account.adAccountId }}@if (account.currency) { · {{ account.currency }} }
                </p>
              </div>
              <span
                [class]="tokenIndicator(account.tokenStatus).class"
                role="img"
                [attr.aria-label]="tokenIndicator(account.tokenStatus).label"
                [title]="tokenIndicator(account.tokenStatus).label"
              >
                <ng-icon [name]="tokenIndicator(account.tokenStatus).icon" size="20" aria-hidden="true" />
              </span>
            </a>
          }
        </div>
      }
    </div>
  `,
})
export class AccountsPage {
  private readonly accountsApi = inject(AccountsApiService);
  private readonly router = inject(Router);

  protected readonly accounts = signal<AdAccountOutput[] | null>(null);
  protected readonly loadFailed = signal(false);

  constructor() {
    this.reload();
  }

  protected tokenIndicator(status: AdAccountOutputTokenStatusEnumKey): TokenIndicator {
    return TOKEN_INDICATOR[status];
  }

  protected goToIntegrations(): void {
    void this.router.navigate(['/integrations']);
  }

  protected reload(): void {
    this.loadFailed.set(false);
    this.accounts.set(null);
    this.accountsApi.list().subscribe({
      next: (rows) => this.accounts.set(rows),
      error: () => {
        this.accounts.set([]);
        this.loadFailed.set(true);
      },
    });
  }
}
