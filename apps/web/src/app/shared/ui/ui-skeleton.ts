import { ChangeDetectionStrategy, Component, input } from '@angular/core';

// Skeleton de carregamento de conteúdo (listas/cards/KPIs) — percepção de rapidez.
@Component({
  selector: 'app-ui-skeleton',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class: 'ui-skeleton',
    '[style.width]': 'width()',
    '[style.height]': 'height()',
  },
  template: '',
})
export class UiSkeleton {
  readonly width = input('100%');
  readonly height = input('1rem');
}
