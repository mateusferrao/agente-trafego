import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, input, signal } from '@angular/core';
import { UiBrandPulse } from './ui-brand-pulse';

const ROTATE_MS = 2100;

// Loading do momento de valor (agente analisando): pulso da marca + UMA frase por vez
// que some e é substituída pela próxima (fade), em ciclo, com "…" no final. Descreve o
// TIPO de trabalho (honesto-genérico), não é checklist que "completa". Passos por INPUT.
// prefers-reduced-motion: não rotaciona (mostra a 1ª frase, estática).
@Component({
  selector: 'app-ui-analysis-progress',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [UiBrandPulse],
  template: `
    <div class="flex flex-col gap-3">
      <app-ui-brand-pulse [label]="title()" />
      @if (steps().length) {
        <div class="ui-analysis-line-wrap">
          @for (line of [currentStep()]; track active()) {
            <p class="ui-analysis-line">{{ line }}…</p>
          }
        </div>
      }
    </div>
  `,
})
export class UiAnalysisProgress {
  readonly title = input('');
  readonly steps = input<readonly string[]>([]);
  protected readonly active = signal(0);
  protected readonly currentStep = computed(() => this.steps()[this.active()] ?? '');

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
