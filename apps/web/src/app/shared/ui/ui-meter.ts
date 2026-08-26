import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

type MeterTone = 'primary' | 'danger' | 'success';

// Barra/meter (meta×realizado, funil). ratio 0..1 (clampado).
@Component({
  selector: 'app-ui-meter',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="ui-meter">
      <span class="ui-meter__fill" [class]="fillClass()" [style.width.%]="pct()"></span>
    </div>
  `,
})
export class UiMeter {
  readonly ratio = input(0);
  readonly tone = input<MeterTone>('primary');
  protected readonly pct = computed(() => Math.round(Math.min(1, Math.max(0, this.ratio())) * 100));
  protected readonly fillClass = computed(() =>
    this.tone() === 'primary' ? '' : `ui-meter__fill--${this.tone()}`,
  );
}
