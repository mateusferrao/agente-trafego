import { ChangeDetectionStrategy, Component, input } from '@angular/core';

// Símbolo da marca (tomate) em pulso/respiração — âncora de loading (nunca gira).
// Reusa .brand-mark; opcionalmente um rótulo ao lado.
@Component({
  selector: 'app-ui-brand-pulse',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <span class="brand-lockup" role="status">
      <span class="brand-mark brand-pulse" aria-hidden="true"></span>
      @if (label()) {
        <span class="text-sm font-semibold text-ink">{{ label() }}</span>
      }
    </span>
  `,
})
export class UiBrandPulse {
  readonly label = input('');
}
