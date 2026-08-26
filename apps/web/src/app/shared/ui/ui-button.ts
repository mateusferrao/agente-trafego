import { computed, Directive, ElementRef, inject, input } from '@angular/core';
import { NgpButton } from 'ng-primitives/button';

type UiButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
type UiButtonSize = 'sm' | 'md';

const BASE_CLASSES =
  'inline-flex items-center justify-center gap-2 rounded-md font-semibold transition ' +
  'focus-visible:outline focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-accent/30 ' +
  'disabled:pointer-events-none disabled:opacity-50 aria-disabled:pointer-events-none aria-disabled:opacity-50';

// Primário = assinatura neobrutalista: navy sólido + sombra offset tomate + "afundar" no hover
// (translate só com motion-safe). Danger = vermelho profundo distinto do tomate de marca.
// Secondary/ghost seguem calmos (nível Workspace): a marca vem do primário e dos cards.
const VARIANT_CLASSES: Record<UiButtonVariant, string> = {
  primary:
    'border-2 border-primary bg-primary text-primary-ink shadow-[var(--shadow-offset-accent)] hover:bg-primary-strong ' +
    'motion-safe:hover:translate-x-[3px] motion-safe:hover:translate-y-[3px] motion-safe:hover:shadow-[var(--shadow-offset-accent-press)]',
  secondary: 'border border-line bg-panel text-ink shadow-card hover:border-accent/40 hover:bg-soft',
  ghost: 'border border-transparent bg-transparent text-muted hover:bg-soft hover:text-ink',
  danger: 'border-2 border-danger bg-danger text-primary-ink shadow-card hover:bg-danger-strong',
};

const SIZE_CLASSES: Record<UiButtonSize, string> = {
  sm: 'h-9 px-3 text-xs',
  md: 'h-10 px-3.5 text-sm',
};

@Directive({
  selector: 'button[appButton], a[appButton]',
  hostDirectives: [
    {
      directive: NgpButton,
      inputs: ['disabled'],
    },
  ],
  host: {
    '[class]': 'classes()',
  },
})
export class UiButton {
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly customClasses = this.host.nativeElement.getAttribute('class') ?? '';

  readonly variant = input<UiButtonVariant>('secondary');
  readonly size = input<UiButtonSize>('md');

  readonly classes = computed(() => `${BASE_CLASSES} ${VARIANT_CLASSES[this.variant()]} ${SIZE_CLASSES[this.size()]} ${this.customClasses}`.trim());
}
