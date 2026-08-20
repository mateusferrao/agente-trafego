import { Directive } from '@angular/core';
import { NgpSwitch, NgpSwitchThumb } from 'ng-primitives/switch';

@Directive({
  selector: 'button[appSwitch]',
  hostDirectives: [
    {
      directive: NgpSwitch,
      inputs: ['id', 'ngpSwitchChecked', 'ngpSwitchDisabled'],
      outputs: ['ngpSwitchCheckedChange'],
    },
  ],
  host: {
    type: 'button',
    class:
      'group inline-flex h-6 min-w-10 shrink-0 items-center rounded-full border border-line bg-soft p-0.5 text-xs font-semibold text-muted transition ' +
      'hover:border-accent/35 hover:bg-panel focus-visible:outline focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-accent/30 ' +
      'data-[checked]:border-accent data-[checked]:bg-accent data-[disabled]:cursor-not-allowed data-[disabled]:opacity-50',
  },
})
export class UiSwitch {}

@Directive({
  selector: '[appSwitchThumb]',
  hostDirectives: [NgpSwitchThumb],
  host: {
    class:
      'pointer-events-none block size-4 rounded-full bg-panel shadow-sm transition-colors duration-150 ease-out ' +
      'group-data-[checked]:bg-panel group-data-[disabled]:bg-muted',
  },
})
export class UiSwitchThumb {}
