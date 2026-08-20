import { computed, Directive, ElementRef, inject, input } from '@angular/core';
import { NgpToggleGroup, NgpToggleGroupItem } from 'ng-primitives/toggle-group';

type UiToggleTone = 'neutral' | 'accent';
type UiToggleLayout = 'wrap' | 'segmented';

const ITEM_BASE_CLASSES =
  'relative z-10 rounded-[0.75rem] px-3 py-1.5 text-sm font-semibold transition focus-visible:outline focus-visible:outline-3 ' +
  'focus-visible:outline-offset-2 focus-visible:outline-accent/30 data-[selected]:shadow-card';

const ITEM_TONE_CLASSES: Record<UiToggleTone, string> = {
  neutral: 'text-muted hover:bg-panel/45 hover:text-ink data-[selected]:bg-panel data-[selected]:text-ink',
  accent: 'text-muted hover:bg-accent-soft/70 hover:text-accent-strong data-[selected]:bg-accent data-[selected]:text-panel',
};

@Directive({
  selector: '[appToggleGroup]',
  hostDirectives: [
    {
      directive: NgpToggleGroup,
      inputs: [
        'ngpToggleGroupOrientation',
        'ngpToggleGroupType',
        'ngpToggleGroupAllowDeselection',
        'ngpToggleGroupValue',
        'ngpToggleGroupDefaultValue',
        'ngpToggleGroupDisabled',
      ],
      outputs: ['ngpToggleGroupValueChange'],
    },
  ],
  host: {
    '[class]': 'classes()',
    '[style.grid-template-columns]': 'gridTemplateColumns()',
  },
})
export class UiToggleGroup {
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly customClasses = this.host.nativeElement.getAttribute('class') ?? '';

  readonly layout = input<UiToggleLayout>('wrap');
  readonly columns = input(3);

  readonly classes = computed(() =>
    `${this.layout() === 'segmented'
      ? 'relative inline-grid w-full rounded-lg border border-line bg-soft p-1'
      : 'inline-flex flex-wrap gap-1 rounded-lg border border-line bg-soft p-1'} ${this.customClasses}`.trim(),
  );

  readonly gridTemplateColumns = computed(() =>
    this.layout() === 'segmented' ? `repeat(${this.columns()}, minmax(0, 1fr))` : null,
  );
}

@Directive({
  selector: '[appToggleIndicator]',
  host: {
    class: 'pointer-events-none absolute inset-y-1 left-1 rounded-[0.75rem] bg-panel shadow-card transition-transform duration-200 ease-out',
    '[style.width]': 'width()',
  },
})
export class UiToggleIndicator {
  readonly columns = input(3);
  readonly width = computed(() => `calc((100% - 0.5rem) / ${this.columns()})`);
}

@Directive({
  selector: 'button[appToggleGroupItem]',
  hostDirectives: [
    {
      directive: NgpToggleGroupItem,
      inputs: ['ngpToggleGroupItemValue', 'ngpToggleGroupItemDisabled'],
    },
  ],
  host: {
    type: 'button',
    '[class]': 'classes()',
  },
})
export class UiToggleGroupItem {
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly customClasses = this.host.nativeElement.getAttribute('class') ?? '';

  readonly tone = input<UiToggleTone>('neutral');
  readonly indicator = input(false);

  readonly classes = computed(() => {
    const toneClasses = this.indicator()
      ? 'hover:bg-panel/40 data-[selected]:!bg-transparent data-[selected]:!shadow-none data-[selected]:text-ink'
      : ITEM_TONE_CLASSES[this.tone()];

    return `${ITEM_BASE_CLASSES} ${toneClasses} ${this.customClasses}`.trim();
  });
}
