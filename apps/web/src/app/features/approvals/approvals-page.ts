import { ChangeDetectionStrategy, Component } from '@angular/core';
import { provideIcons } from '@ng-icons/core';
import { heroCheckCircle } from '@ng-icons/heroicons/outline';
import { UiEmptyState, UiPageHeader } from '@ui';

/**
 * Aprovações = fila de ações que aguardam o OK humano (HITL — CLAUDE.md §7/§8).
 * Placeholder "em breve" na Fatia 1a: a fila real chega quando a escrita na Meta abrir.
 */
@Component({
  selector: 'app-approvals-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [UiEmptyState, UiPageHeader],
  providers: [provideIcons({ heroCheckCircle })],
  template: `
    <div class="flex flex-col gap-8">
      <app-ui-page-header
        title="Aprovações"
        subtitle="Ações que aguardam seu OK antes de serem aplicadas."
      />
      <app-ui-empty-state
        icon="heroCheckCircle"
        title="Em breve"
        description="Quando o agente propuser mudanças que precisam da sua confirmação, elas aparecem aqui."
      />
    </div>
  `,
})
export class ApprovalsPage {}
