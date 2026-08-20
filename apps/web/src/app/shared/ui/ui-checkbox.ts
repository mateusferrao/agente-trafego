import { Directive, forwardRef, inject } from '@angular/core';
import { NG_VALUE_ACCESSOR } from '@angular/forms';
import type { ControlValueAccessor } from '@angular/forms';
import { NgpCheckbox } from 'ng-primitives/checkbox';

@Directive({
  selector: 'button[appCheckbox]',
  providers: [
    {
      provide: NG_VALUE_ACCESSOR,
      useExisting: forwardRef(() => UiCheckbox),
      multi: true,
    },
  ],
  hostDirectives: [
    {
      directive: NgpCheckbox,
      inputs: [
        'id',
        'ngpCheckboxChecked',
        'ngpCheckboxDefaultChecked',
        'ngpCheckboxIndeterminate',
        'ngpCheckboxRequired',
        'ngpCheckboxDisabled',
      ],
      outputs: ['ngpCheckboxCheckedChange', 'ngpCheckboxIndeterminateChange'],
    },
  ],
  host: {
    type: 'button',
    '(blur)': 'markAsTouched()',
    class:
      'group grid size-5 shrink-0 place-items-center rounded-sm border border-line bg-panel text-panel transition ' +
      'hover:border-accent/45 focus-visible:outline focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-accent/30 ' +
      'data-[checked]:border-accent data-[checked]:bg-accent data-[disabled]:cursor-not-allowed data-[disabled]:opacity-50',
  },
})
export class UiCheckbox implements ControlValueAccessor {
  private readonly checkbox = inject(NgpCheckbox, { self: true });
  private onChange: (value: boolean) => void = () => {};
  private onTouched: () => void = () => {};

  constructor() {
    this.checkbox.checkedChange.subscribe((value) => {
      this.onChange(value);
    });
  }

  writeValue(value: unknown): void {
    this.checkbox.setChecked(value === true, { emit: false });
  }

  registerOnChange(fn: (value: boolean) => void): void {
    this.onChange = fn;
  }

  registerOnTouched(fn: () => void): void {
    this.onTouched = fn;
  }

  setDisabledState(isDisabled: boolean): void {
    this.checkbox.setDisabled(isDisabled);
  }

  markAsTouched(): void {
    this.onTouched();
  }
}
