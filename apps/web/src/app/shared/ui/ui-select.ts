import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import { NgpSelectPortal } from 'ng-primitives/select';
import { UiSelect, UiSelectDropdown, UiSelectOption } from './ui-form-controls';

export interface UiSelectOptionItem {
  readonly value: string;
  readonly label: string;
  readonly disabled?: boolean;
}

/**
 * Select estilizado (dropdown ng-primitives) com API por SIGNAL — encaixa no padrão
 * signals do app (sem Reactive Forms). `<app-ui-select [options] [value] (valueChange)>`.
 * Valores são strings (para numéricos, converta na borda). Vendorizado sobre o trio
 * `appSelect`/`appSelectDropdown`/`appSelectOption` do design-system.
 */
@Component({
  selector: 'app-ui-select',
  standalone: true,
  imports: [NgpSelectPortal, UiSelect, UiSelectDropdown, UiSelectOption],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div
      appSelect
      [ngpSelectValue]="value()"
      [ngpSelectDisabled]="disabled()"
      (ngpSelectValueChange)="valueChange.emit($event)"
    >
      <span class="truncate" [class.text-muted]="!hasSelection()">{{ displayLabel() }}</span>
      <div *ngpSelectPortal appSelectDropdown>
        @for (opt of options(); track opt.value) {
          <div
            appSelectOption
            [ngpSelectOptionValue]="opt.value"
            [ngpSelectOptionDisabled]="opt.disabled ?? false"
          >
            <span class="truncate">{{ opt.label }}</span>
          </div>
        }
      </div>
    </div>
  `,
})
export class UiSelectBox {
  readonly options = input<ReadonlyArray<UiSelectOptionItem>>([]);
  readonly value = input<string | null>(null);
  readonly placeholder = input('— Selecione —');
  readonly disabled = input(false);
  readonly valueChange = output<string>();

  protected readonly hasSelection = computed(() => {
    const v = this.value();
    return v !== null && v !== '';
  });

  protected readonly displayLabel = computed(() => {
    const v = this.value();
    return this.options().find((o) => o.value === v)?.label ?? this.placeholder();
  });
}
