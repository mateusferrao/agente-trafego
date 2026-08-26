import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

type EvidenceTone = 'neutral' | 'danger' | 'success';

// Chip de evidência numérica (metricRefs): rótulo + número — no lugar da caixa cinza.
@Component({
  selector: 'app-ui-evidence',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '[class]': 'classes()' },
  template: '<ng-content />',
})
export class UiEvidence {
  readonly tone = input<EvidenceTone>('neutral');
  protected readonly classes = computed(() =>
    this.tone() === 'neutral' ? 'ui-evidence' : `ui-evidence ui-evidence--${this.tone()}`,
  );
}
