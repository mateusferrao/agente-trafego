import { ChangeDetectionStrategy, Component } from '@angular/core';
import { RouterLink } from '@angular/router';
import { provideIcons } from '@ng-icons/core';
import { heroBuildingOffice2 } from '@ng-icons/heroicons/outline';
import { UiButton, UiEmptyState, UiPageHeader } from '@ui';

/**
 * Contas = landing do app (rota '/'). Lista as ad accounts Meta conectadas
 * (CLAUDE.md §6). Na Fatia 1a ainda não há dados: mostra o cabeçalho + empty state
 * convidando a conectar a primeira conta. CTA leva ao onboarding guiado.
 */
@Component({
  selector: 'app-accounts-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, UiButton, UiEmptyState, UiPageHeader],
  providers: [provideIcons({ heroBuildingOffice2 })],
  template: `
    <div class="flex flex-col gap-8">
      <app-ui-page-header
        title="Contas"
        subtitle="Contas de anúncio Meta conectadas e seus agentes."
      >
        <a appButton variant="primary" routerLink="/onboarding" actions>Conectar conta</a>
      </app-ui-page-header>

      <app-ui-empty-state
        icon="heroBuildingOffice2"
        title="Conecte sua primeira conta"
        description="Cole seu System User token, escolha as contas de anúncio e o agente já começa a acompanhar as campanhas."
      >
        <a appButton variant="primary" routerLink="/onboarding" actions>Conectar conta</a>
      </app-ui-empty-state>
    </div>
  `,
})
export class AccountsPage {}
