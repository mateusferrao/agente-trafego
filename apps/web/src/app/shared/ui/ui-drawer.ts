import { Directive, input } from '@angular/core';

type UiDrawerSide = 'left' | 'right';

@Directive({
  selector: '[appUiDrawerOverlay]',
  host: {
    class: 'fixed inset-0 z-50 flex bg-overlay',
    '[class.justify-start]': "side() === 'left'",
    '[class.justify-end]': "side() === 'right'",
  },
})
export class UiDrawerOverlay {
  readonly side = input<UiDrawerSide>('right');
}

@Directive({
  selector: '[appUiDrawer]',
  host: {
    class: 'flex h-full w-full max-w-[26.25rem] flex-col overflow-hidden bg-panel text-ink shadow-panel',
    '[class.border-r]': "side() === 'left'",
    '[class.border-l]': "side() === 'right'",
    '[class.border-line]': 'true',
  },
})
export class UiDrawer {
  readonly side = input<UiDrawerSide>('right');
}

@Directive({
  selector: '[appUiDrawerHeader]',
  host: {
    class: 'flex min-h-16 items-start justify-between gap-3 border-b border-line px-5 py-4',
  },
})
export class UiDrawerHeader {}

@Directive({
  selector: '[appUiDrawerBody]',
  host: {
    class: 'min-h-0 flex-1 overflow-y-auto px-5 py-4',
  },
})
export class UiDrawerBody {}

@Directive({
  selector: '[appUiDrawerFooter]',
  host: {
    class: 'flex flex-wrap items-center justify-end gap-2 border-t border-line px-5 py-4',
  },
})
export class UiDrawerFooter {}
