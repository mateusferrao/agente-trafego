import { ChangeDetectionStrategy, Component, DestroyRef, inject, input, signal } from '@angular/core';
import { UiBrandPulse } from './ui-brand-pulse';

const ROTATE_MS = 1900;

// Loading do momento de valor (agente analisando): pulso da marca + narrativa
// honesta-genérica que ROTACIONA entre as frases (uma ativa por vez, em ciclo).
// Os passos descrevem o TIPO de trabalho e entram por INPUT (o componente é só
// apresentação; a copy vive perto do domínio). Não é checklist que "completa" —
// é um ciclo ambiente. prefers-reduced-motion: não rotaciona (mostra tudo legível).
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
          @for (step of steps(); track step; let i = $index) {
            <li [class.is-active]="i === active()">{{ step }}</li>
          }
        </ul>
      }
    </div>
  `,
})
export class UiAnalysisProgress {
  readonly title = input('');
  readonly steps = input<readonly string[]>([]);
  protected readonly active = signal(0);

  constructor() {
    const reduce =
      typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    if (reduce) return;
    const id = setInterval(() => {
      const n = this.steps().length;
      if (n > 0) this.active.update((i) => (i + 1) % n);
    }, ROTATE_MS);
    inject(DestroyRef).onDestroy(() => clearInterval(id));
  }
}
