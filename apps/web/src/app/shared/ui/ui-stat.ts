import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

type StatTone = 'ink' | 'danger' | 'success' | 'accent';

const TONE_CLASS: Record<StatTone, string> = {
  ink: 'text-ink',
  danger: 'text-danger-strong',
  success: 'text-success-strong',
  accent: 'text-accent-strong',
};

// Stat de valor (dinheiro/KPI): número grande em mono + rótulo eyebrow.
@Component({
  selector: 'app-ui-stat',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="flex flex-col gap-0.5">
      <span class="ui-eyebrow">{{ label() }}</span>
      <span class="ui-stat__value text-2xl" [class]="toneClass()">{{ value() }}</span>
      @if (note()) {
        <span class="text-xs text-muted">{{ note() }}</span>
      }
    </div>
  `,
})
export class UiStat {
  readonly label = input('');
  readonly value = input('');
  readonly note = input('');
  readonly tone = input<StatTone>('ink');
  protected readonly toneClass = computed(() => TONE_CLASS[this.tone()]);
}
