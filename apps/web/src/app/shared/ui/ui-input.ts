import { Directive, ElementRef, booleanAttribute, inject, input } from '@angular/core';
import { NgControl } from '@angular/forms';
import { NgpInput } from 'ng-primitives/input';

type UiInputSurface = 'panel' | 'transparent';

// Foco/hover em NAVY (ink), neutro — caqui agora é o accent de marca e leria como erro
// num campo. Estado inválido usa o vermelho profundo de perigo (distinto do caqui).
const INPUT_BASE_CLASSES =
  'h-10 w-full rounded-md border border-line px-3 text-sm font-medium text-ink transition ' +
  'placeholder:text-muted/70 hover:border-muted/60 focus:border-ink focus:outline-none ' +
  'focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50';
const INVALID_CLASSES =
  'border-danger bg-danger-soft/40 hover:border-danger focus:border-danger';

const INPUT_SURFACE_CLASSES: Record<UiInputSurface, string> = {
  panel: 'bg-panel',
  transparent: 'bg-transparent',
};

@Directive({
  selector: 'input[appInput]',
  hostDirectives: [
    {
      directive: NgpInput,
      inputs: ['id', 'disabled'],
    },
  ],
  host: {
    '[class]': 'classes()',
  },
})
export class UiInput {
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly control = inject(NgControl, { optional: true, self: true });
  private readonly customClasses = this.host.nativeElement.getAttribute('class') ?? '';

  readonly surface = input<UiInputSurface>('panel');
  readonly leadingIcon = input(false, { transform: booleanAttribute });
  readonly trailingAction = input(false, { transform: booleanAttribute });
  readonly invalid = input<boolean | null>(null);

  classes() {
    return [
      INPUT_BASE_CLASSES,
      INPUT_SURFACE_CLASSES[this.surface()],
      this.leadingIcon() ? 'pl-9' : '',
      this.trailingAction() ? 'pr-16' : '',
      this.isInvalid() ? INVALID_CLASSES : '',
      this.customClasses,
    ].join(' ');
  }

  private isInvalid() {
    const invalid = this.invalid();

    if (invalid !== null) {
      return invalid;
    }

    const control = this.control?.control;
    return Boolean(control?.invalid && (control.touched || control.dirty));
  }
}
