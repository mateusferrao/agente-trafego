import { ChangeDetectionStrategy, Component } from '@angular/core';

// Rótulo de seção/categoria em mono (estilo site) — substitui os pills cinza.
@Component({
  selector: 'app-ui-eyebrow',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'ui-eyebrow' },
  template: '<ng-content />',
})
export class UiEyebrow {}
