import { Directive, ElementRef, inject } from '@angular/core';

const LABEL_CLASSES = 'text-xs font-medium leading-5 text-muted';

@Directive({
  selector: '[appUiLabel]',
  standalone: true,
  host: {
    '[class]': 'classes',
  },
})
export class UiLabel {
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly customClasses = this.host.nativeElement.getAttribute('class') ?? '';

  readonly classes = `${LABEL_CLASSES} ${this.customClasses}`.trim();
}
