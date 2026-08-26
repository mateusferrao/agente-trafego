// Casca da conta (6a): cabeçalho persistente (nome + status + Analisar agora +
// Pausar) + banner de token + router-tabs (Visão geral · Agente · Timeline) +
// <router-outlet> no painel. Provê o AccountContextStore (scoped à rota) que o
// cabeçalho e a aba "Visão geral" compartilham. Aba "Conexões" = fast-follow.

import { ChangeDetectionStrategy, Component, inject } from "@angular/core";
import { RouterLink, RouterLinkActive, RouterOutlet } from "@angular/router";
import { UiAgentIdentity, UiBadge, UiButton, UiPageHeader, UiRouteTabLink, UiRouteTabPanel, UiRouteTabs } from "@ui";
import { AccountContextStore } from "./account-context.store";

@Component({
  selector: "app-account-shell",
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [AccountContextStore],
  imports: [
    RouterLink,
    RouterLinkActive,
    RouterOutlet,
    UiAgentIdentity,
    UiBadge,
    UiButton,
    UiPageHeader,
    UiRouteTabs,
    UiRouteTabLink,
    UiRouteTabPanel,
  ],
  template: `
    <div class="flex flex-col gap-6">
      <div class="flex flex-col gap-1">
        <a routerLink="/accounts" class="text-xs text-muted hover:text-ink">← Contas</a>
        <app-ui-page-header [title]="store.accountName()" [subtitle]="store.accountSubtitle()">
          <div class="flex flex-wrap items-center gap-2" actions>
            <app-ui-agent-identity />
            <span appBadge [tone]="store.paused() ? 'warning' : 'success'" size="sm">
              {{ store.paused() ? 'Agente pausado' : 'Agente ativo' }}
            </span>
            <button
              appButton
              variant="secondary"
              type="button"
              [disabled]="store.pausing()"
              (click)="store.togglePaused()"
            >
              {{ store.pausing() ? 'Salvando…' : store.paused() ? 'Retomar' : 'Pausar' }}
            </button>
            <button
              appButton
              variant="primary"
              type="button"
              [disabled]="store.analyzing()"
              (click)="store.analyze()"
            >
              {{ store.analyzing() ? 'Analisando…' : 'Analisar agora' }}
            </button>
          </div>
        </app-ui-page-header>
      </div>

      @if (store.account()?.tokenStatus === 'invalid') {
        <div class="rounded-lg border border-line bg-panel p-4 text-sm text-danger-strong">
          O token da integração com a Meta expirou, então as análises desta conta estão paradas.
          <a routerLink="/integrations" class="underline">Reconecte em Integrações</a> para retomar.
        </div>
      }

      <nav appRouteTabs aria-label="Seções da conta">
        <a
          appRouteTabLink
          routerLink="."
          routerLinkActive
          ariaCurrentWhenActive="page"
          [routerLinkActiveOptions]="{ exact: true }"
        >
          Visão geral
        </a>
        <a appRouteTabLink routerLink="agente" routerLinkActive ariaCurrentWhenActive="page">Agente</a>
        <a appRouteTabLink routerLink="timeline" routerLinkActive ariaCurrentWhenActive="page">Timeline</a>
      </nav>

      <div appRouteTabPanel>
        <router-outlet />
      </div>
    </div>
  `,
})
export class AccountShell {
  protected readonly store = inject(AccountContextStore);
}
