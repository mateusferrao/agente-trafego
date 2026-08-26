import { computed, Directive, ElementRef, inject, input } from '@angular/core';

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
@Directive({
  selector: '[appUiPanelCard]',
  standalone: true,
  host: {
    '[class]': 'classes()',
  },
})
export class UiPanelCard {
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly customClasses = this.host.nativeElement.getAttribute('class') ?? '';

  readonly variant = input<'workspace' | 'brand'>('workspace');

  readonly classes = computed(() =>
    `ui-panel-card ${this.variant() === 'brand' ? 'ui-panel-card--brand' : ''} ${this.customClasses}`.trim(),
  );
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
