import { Directive } from '@angular/core';

@Directive({
  selector: '[appUiPanelGrid]',
  standalone: true,
  host: {
    class: 'ui-panel-grid',
  },
})
export class UiPanelGrid {}

@Directive({
  selector: '[appUiPanelCard]',
  standalone: true,
  host: {
    class: 'ui-panel-card',
  },
})
export class UiPanelCard {}

@Directive({
  selector: '[appUiPanelTitle]',
  standalone: true,
  host: {
    class: 'ui-panel-title',
  },
})
export class UiPanelTitle {}

@Directive({
  selector: '[appUiPanelText]',
  standalone: true,
  host: {
    class: 'ui-panel-text',
  },
})
export class UiPanelText {}
