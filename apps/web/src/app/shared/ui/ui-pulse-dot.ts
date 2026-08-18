import { ChangeDetectionStrategy, Component, Input } from '@angular/core';

@Component({
  selector: 'app-ui-pulse-dot',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <span class="ui-pulse-dot" [style.width.rem]="sizeRem" [style.height.rem]="sizeRem"></span>
  `,
  styles: [
    `
      :host {
        display: inline-flex;
        line-height: 0;
      }

      .ui-pulse-dot {
        display: inline-block;
        border-radius: var(--radius-pill);
        background: var(--ui-pulse-dot-color, var(--color-accent));
        box-shadow: 0 0 0 0
          color-mix(in oklch, var(--ui-pulse-dot-color, var(--color-accent)) 35%, transparent);
        animation: ui-pulse-dot 1.3s ease-out infinite;
      }

      @keyframes ui-pulse-dot {
        70%,
        100% {
          box-shadow: 0 0 0 0.45rem transparent;
        }
      }

      @media (prefers-reduced-motion: reduce) {
        .ui-pulse-dot {
          animation-duration: 2.6s;
        }
      }
    `,
  ],
})
export class UiPulseDotComponent {
  @Input() sizeRem = 0.45;
}
