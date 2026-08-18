import { ChangeDetectionStrategy, Component } from '@angular/core';
import { provideIcons } from '@ng-icons/core';
import { heroSquares2x2 } from '@ng-icons/heroicons/outline';
import { UiEmptyState, UiPageHeader } from '@ui';

/**
 * Integrações = conexões com a plataforma de ads (Meta) e o canal (WhatsApp/Evolution).
 * Placeholder "em breve" na Fatia 1a: a gestão das conexões chega junto do onboarding.
 */
@Component({
  selector: 'app-integrations-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [UiEmptyState, UiPageHeader],
  providers: [provideIcons({ heroSquares2x2 })],
  template: `
    <div class="flex flex-col gap-8">
      <app-ui-page-header
        title="Integrações"
        subtitle="Conexões com a Meta e o canal de WhatsApp."
      />
      <app-ui-empty-state
        icon="heroSquares2x2"
        title="Em breve"
        description="Aqui você vai conectar e acompanhar a saúde das integrações da sua organização."
      />
    </div>
  `,
})
export class IntegrationsPage {}
