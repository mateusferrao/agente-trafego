// Vendorizado do design-system Automato (ver VENDORING.md). Subconjunto: o trio de
// SELECT estilizado (ng-primitives) — trigger + dropdown + option. O <app-ui-select>
// (ui-select.ts) embrulha isso numa API declarativa por signal.
import { Directive, ElementRef, inject, input } from '@angular/core';
import { NgControl } from '@angular/forms';
import { NgpSelect, NgpSelectDropdown, NgpSelectOption } from 'ng-primitives/select';

const SELECT_BASE_CLASSES =
  'app-ui-select flex min-h-10 w-full min-w-0 cursor-pointer items-center justify-between gap-3 overflow-hidden rounded-md border border-line bg-panel px-3 py-2 pr-9 ' +
  'text-sm font-medium text-ink transition hover:border-accent/35 data-[focus]:border-accent data-[focus]:bg-accent-soft/25 ' +
  'data-[focus]:outline-none data-[disabled]:cursor-not-allowed data-[disabled]:opacity-50';
const SELECT_INVALID_CLASSES =
  'border-danger bg-danger-soft/45 hover:border-danger data-[focus]:border-danger data-[focus]:bg-danger-soft/35';

@Directive({
  selector: '[appSelect]',
  hostDirectives: [
    {
      directive: NgpSelect,
      inputs: [
        'id',
        'ngpSelectValue',
        'ngpSelectMultiple',
        'ngpSelectDisabled',
        'ngpSelectDropdownPlacement',
        'ngpSelectDropdownContainer',
        'ngpSelectDropdownFlip',
        'ngpSelectDropdownOffset',
        'ngpSelectScrollToOption',
      ],
      outputs: ['ngpSelectValueChange', 'ngpSelectOpenChange'],
    },
  ],
  host: {
    '[class]': 'classes()',
  },
})
export class UiSelect {
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly control = inject(NgControl, { optional: true, self: true });
  private readonly customClasses = this.host.nativeElement.getAttribute('class') ?? '';

  readonly invalid = input<boolean | null>(null);

  classes(): string {
    return [SELECT_BASE_CLASSES, this.isInvalid() ? SELECT_INVALID_CLASSES : '', this.customClasses].join(' ');
  }

  private isInvalid(): boolean {
    const invalid = this.invalid();
    if (invalid !== null) return invalid;
    const control = this.control?.control;
    return Boolean(control?.invalid && (control.touched || control.dirty));
  }
}

@Directive({
  selector: '[appSelectDropdown]',
  hostDirectives: [NgpSelectDropdown],
  host: {
    class:
      'glass-surface fixed z-50 mt-1 min-w-[var(--ngp-select-width)] overflow-y-auto overscroll-contain rounded-lg border border-line bg-panel/95 p-1.5 text-sm text-ink shadow-panel',
  },
})
export class UiSelectDropdown {}

@Directive({
  selector: '[appSelectOption]',
  hostDirectives: [
    {
      directive: NgpSelectOption,
      inputs: ['id', 'ngpSelectOptionValue', 'ngpSelectOptionDisabled', 'ngpSelectOptionIndex'],
    },
  ],
  host: {
    class:
      'flex min-h-9 cursor-pointer items-center justify-between gap-3 rounded-md px-3 py-2 text-sm font-medium text-ink transition ' +
      'data-[hover]:bg-soft data-[active]:bg-soft data-[selected]:bg-accent-soft data-[selected]:text-accent-strong ' +
      'data-[disabled]:cursor-not-allowed data-[disabled]:opacity-50',
  },
})
export class UiSelectOption {}
