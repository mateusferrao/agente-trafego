// Casca da conta (6a): cabeçalho persistente (nome + status + Analisar agora +
// Pausar) + banner de token + router-tabs (Visão geral · Agente · Timeline) +
// <router-outlet> no painel. Provê o AccountContextStore (scoped à rota) que o
// cabeçalho e a aba "Visão geral" compartilham. Aba "Conexões" = fast-follow.

import { ChangeDetectionStrategy, Component, inject } from "@angular/core";
import { RouterLink, RouterLinkActive, RouterOutlet } from "@angular/router";
import { UiAgentIdentity, UiButton, UiPageHeader, UiRouteTabLink, UiRouteTabPanel, UiRouteTabs } from "@ui";
import { AccountContextStore } from "./account-context.store";
import { accountHealthLabel } from "../../shared/account-health-labels";

@Component({
  selector: "app-account-shell",
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [AccountContextStore],
  imports: [
    RouterLink,
    RouterLinkActive,
    RouterOutlet,
    UiAgentIdentity,
    UiButton,
    UiPageHeader,
    UiRouteTabs,
    UiRouteTabLink,
    UiRouteTabPanel,
  ],
  template: `
    <div class="flex flex-col gap-6">
      <!-- Mobile (<920px, mesmo breakpoint do ui-page-header): o perfil do agente vai
           acima de tudo, canto superior esquerdo — no desktop some daqui e reaparece
           ao lado dos botões (abaixo), onde já cabe sem empurrar o título. -->
      <div class="flex items-center gap-2.5 min-[920px]:hidden">
        <app-ui-agent-identity [status]="store.paused() ? 'paused' : 'active'" />
      </div>
      <div class="flex flex-col gap-1">
        <a routerLink="/accounts" class="text-xs text-muted hover:text-ink">← Contas</a>
        <app-ui-page-header [title]="store.accountName()" [subtitle]="store.accountSubtitle()">
          <div class="flex flex-col items-end gap-2" actions>
            <div class="hidden min-[920px]:flex">
              <app-ui-agent-identity [status]="store.paused() ? 'paused' : 'active'" />
            </div>
            <div class="flex flex-wrap items-center gap-2">
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
          </div>
        </app-ui-page-header>
      </div>

      @if (store.account()?.tokenStatus === 'invalid') {
        <div class="rounded-lg border border-line bg-panel p-4 text-sm text-danger-strong">
          O token da integração com a Meta expirou, então as análises desta conta estão paradas.
          <a routerLink="/integrations" class="underline">Reconecte em Integrações</a> para retomar.
        </div>
      }

      @if (accountHealthBanner(); as label) {
        <div class="rounded-lg border border-line bg-panel p-4 text-sm text-danger-strong">
          Conta na Meta: {{ label }}. Suas campanhas podem ter parado de rodar — veja os detalhes na Visão geral ou no Gerenciador de Anúncios.
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
        <a appRouteTabLink routerLink="criativos" routerLinkActive ariaCurrentWhenActive="page">Criativos</a>
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

  /** Rótulo do banner de saúde da conta Meta quando NÃO-ativa; null = ok/sem dado. */
  protected accountHealthBanner(): string | null {
    return accountHealthLabel(this.store.account()?.accountHealthStatus);
  }
}
