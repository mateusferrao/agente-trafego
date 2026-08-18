import { computed, Directive, ElementRef, inject, input } from '@angular/core';

type UiBadgeTone = 'success' | 'warning' | 'danger' | 'info' | 'neutral' | 'accent';
type UiBadgeSize = 'xs' | 'sm';

const BASE =
  'inline-flex items-center gap-1 rounded-full px-2 py-0.5 font-medium leading-none whitespace-nowrap';

const TONES: Record<UiBadgeTone, string> = {
  success: 'bg-success-soft text-success-strong',
  warning: 'bg-warning-soft text-warning-strong',
  danger: 'bg-danger-soft text-danger-strong',
  info: 'bg-info-soft text-info-strong',
  neutral: 'bg-soft text-muted',
  accent: 'bg-accent-soft text-accent-strong',
};

const SIZES: Record<UiBadgeSize, string> = {
  xs: 'text-[10px] uppercase tracking-wide',
  sm: 'text-xs',
};

@Directive({
  selector: '[appBadge]',
  host: { '[class]': 'classes()' },
})
export class UiBadge {
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly customClasses = this.host.nativeElement.getAttribute('class') ?? '';

  readonly tone = input<UiBadgeTone>('neutral');
  readonly size = input<UiBadgeSize>('sm');

  readonly classes = computed(() => `${BASE} ${TONES[this.tone()]} ${SIZES[this.size()]} ${this.customClasses}`.trim());
}
