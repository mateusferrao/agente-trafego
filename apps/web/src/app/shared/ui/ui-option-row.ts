import { booleanAttribute, Directive, Input } from '@angular/core';

@Directive({
  selector: 'button[appUiOptionRow]',
  standalone: true,
  host: {
    class: 'ui-option-row',
    '[class.ui-option-row--selected]': 'selected',
    '[class.ui-option-row--tall]': 'tall',
    '[class.ui-option-row--compact]': 'compact',
    '[attr.data-selected]': 'selected ? "" : null',
  },
})
export class UiOptionRow {
  @Input({ transform: booleanAttribute }) selected = false;
  @Input({ transform: booleanAttribute }) tall = false;
  @Input({ transform: booleanAttribute }) compact = false;
}

@Directive({
  selector: '[appUiOptionRowCheck]',
  standalone: true,
  host: {
    class: 'ui-option-row__check',
  },
})
export class UiOptionRowCheck {}

@Directive({
  selector: '[appUiOptionRowIcon]',
  standalone: true,
  host: {
    class: 'ui-option-row__icon',
  },
})
export class UiOptionRowIcon {}

@Directive({
  selector: '[appUiOptionRowCopy]',
  standalone: true,
  host: {
    class: 'ui-option-row__copy',
  },
})
export class UiOptionRowCopy {}
