import { ChangeDetectionStrategy, Component, Input } from '@angular/core';

@Component({
  selector: 'app-ui-spinner',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <span
      class="ui-spinner"
      [style.width.px]="size"
      [style.height.px]="size"
      [style.border-width.px]="stroke"
    ></span>
  `,
  styles: [
    `
      .ui-spinner {
        display: inline-block;
        border-style: solid;
        border-color: color-mix(in oklch, var(--color-accent) 25%, var(--color-line));
        border-top-color: var(--color-accent);
        border-radius: var(--radius-pill);
        animation: ui-spinner-spin 0.9s linear infinite;
      }

      @keyframes ui-spinner-spin {
        to {
          transform: rotate(360deg);
        }
      }

      @media (prefers-reduced-motion: reduce) {
        .ui-spinner {
          animation-duration: 1.8s;
        }
      }
    `,
  ],
})
export class UiSpinnerComponent {
  @Input() size = 36;
  @Input() stroke = 3;
}
