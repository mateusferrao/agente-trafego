import { Directive, HostBinding, Input } from '@angular/core';

export type UiHintTone = 'neutral' | 'warning';

@Directive({
  selector: '[appUiHint]',
  host: {
    class: 'm-0 text-xs leading-5',
  },
})
export class UiHint {
  @Input('appUiHint') tone: UiHintTone | '' = 'neutral';

  @HostBinding('class.text-muted')
  get isNeutral(): boolean {
    return this.tone !== 'warning';
  }

  @HostBinding('class.text-tomato')
  get isWarning(): boolean {
    return this.tone === 'warning';
  }
}
