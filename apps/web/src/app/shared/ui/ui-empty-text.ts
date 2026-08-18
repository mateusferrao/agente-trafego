import { Directive } from '@angular/core';

@Directive({
  selector: '[appUiEmptyText]',
  host: {
    class: 'block px-2 py-2 text-center text-xs leading-5 text-muted',
  },
})
export class UiEmptyText {}
