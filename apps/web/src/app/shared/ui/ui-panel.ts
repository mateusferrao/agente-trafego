import { Directive, input } from '@angular/core';

@Directive({
  selector: '[appUiPanelGrid]',
  standalone: true,
  host: {
    class: 'ui-panel-grid',
  },
})
export class UiPanelGrid {}

// variant='brand' aplica a assinatura neobrutalista (borda 2px + sombra offset);
// 'workspace' (default) fica calmo/plano para dados densos (Two-Tier Surface).
// Host binding idiomático: o Angular faz o merge das classes do consumidor.
@Directive({
  selector: '[appUiPanelCard]',
  standalone: true,
  host: {
    class: 'ui-panel-card',
    '[class.ui-panel-card--brand]': "variant() === 'brand'",
  },
})
export class UiPanelCard {
  readonly variant = input<'workspace' | 'brand'>('workspace');
}

@Directive({
  selector: '[appUiPanelTitle]',
  standalone: true,
  host: {
    class: 'ui-panel-title',
  },
})
export class UiPanelTitle {}

@Directive({
  selector: '[appUiPanelText]',
  standalone: true,
  host: {
    class: 'ui-panel-text',
  },
})
export class UiPanelText {}
