import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { UiBrandPulse } from './ui-brand-pulse';

// Loading do momento de valor (agente analisando): pulso da marca + narrativa
// honesta-genérica. Os passos descrevem o TIPO de trabalho e entram por INPUT
// (o componente é só apresentação; a copy vive perto do domínio de análise).
// Não é checklist que "completa" — highlight ambiente, sem fingir progresso real.
@Component({
  selector: 'app-ui-analysis-progress',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [UiBrandPulse],
  template: `
    <div class="flex flex-col gap-3">
      <app-ui-brand-pulse [label]="title()" />
      @if (steps().length) {
        <ul class="ui-analysis-steps">
          @for (step of steps(); track step) {
            <li>{{ step }}</li>
          }
        </ul>
      }
    </div>
  `,
})
export class UiAnalysisProgress {
  readonly title = input('');
  readonly steps = input<readonly string[]>([]);
}
