import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { RouterLink } from '@angular/router';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideArrowLeft } from '@ng-icons/lucide';

@Component({
  selector: 'app-ui-page-header',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [NgIcon, RouterLink],
  providers: [provideIcons({ lucideArrowLeft })],
  host: {
    class: 'block',
  },
  template: `
    <header
      class="ui-page-header"
      [class.ui-page-header--compact]="density() === 'compact'"
      [class.ui-page-header--divider]="divider()"
    >
      <div class="ui-page-header__main">
        @if (backLink(); as backLink) {
          <a class="ui-page-header__back" [routerLink]="backLink" [attr.aria-label]="backLabel() || 'Voltar'">
            <ng-icon name="lucideArrowLeft" size="14" aria-hidden="true" />
            <span>{{ backLabel() || 'Voltar' }}</span>
          </a>
        }

        <div class="ui-page-header__heading">
          <div class="ui-page-header__before" [class.ui-page-header__before--plain]="!beforeSurface()">
            <ng-content select="[beforeTitle]" />
          </div>

          <div class="ui-page-header__copy">
            @if (eyebrow()) {
              <p class="ui-page-header__eyebrow">{{ eyebrow() }}</p>
            }

            <div class="ui-page-header__headline">
              <h1 class="ui-page-header__title">{{ title() }}</h1>

              @if (count() !== undefined && count() !== null) {
                <span class="ui-page-header__count">{{ count() }}</span>
              }

              <div class="ui-page-header__meta">
                <ng-content select="[meta]" />
              </div>
            </div>

            @if (subtitle()) {
              <p class="ui-page-header__subtitle">{{ subtitle() }}</p>
            }
          </div>
        </div>
      </div>

      <div class="ui-page-header__actions">
        <ng-content select="[actions]" />
      </div>
    </header>
  `,
  styles: [
    `
      .ui-page-header {
        display: grid;
        gap: 1rem;
      }

      .ui-page-header--divider {
        border-bottom: 1px solid color-mix(in oklch, var(--color-line) 70%, transparent);
        padding-bottom: 0.75rem;
      }

      .ui-page-header__main {
        display: grid;
        min-width: 0;
        gap: 0.45rem;
      }

      .ui-page-header__back {
        display: inline-flex;
        width: fit-content;
        align-items: center;
        gap: 0.35rem;
        color: var(--color-muted);
        font-size: 0.78rem;
        font-weight: 650;
        text-decoration: none;
        transition: color 140ms ease;
      }

      .ui-page-header__back:hover {
        color: var(--color-accent-strong);
      }

      .ui-page-header__back:focus-visible {
        outline: 3px solid color-mix(in oklch, var(--color-accent) 30%, transparent);
        outline-offset: 2px;
      }

      .ui-page-header__heading {
        display: flex;
        min-width: 0;
        align-items: flex-start;
        gap: 0.85rem;
      }

      .ui-page-header__before:empty,
      .ui-page-header__meta:empty,
      .ui-page-header__actions:empty {
        display: none;
      }

      .ui-page-header__before {
        display: grid;
        flex: 0 0 auto;
        width: 2.35rem;
        height: 2.35rem;
        place-items: center;
        border: 1px solid color-mix(in oklch, var(--color-accent) 18%, var(--color-line));
        border-radius: var(--radius-md);
        background: color-mix(in oklch, var(--color-accent-soft) 44%, var(--color-panel));
        color: var(--color-accent-strong);
      }

      .ui-page-header__before--plain {
        width: auto;
        height: auto;
        border: 0;
        border-radius: 0;
        background: transparent;
        color: inherit;
      }

      .ui-page-header__copy {
        display: grid;
        min-width: 0;
        gap: 0.2rem;
      }

      .ui-page-header__eyebrow {
        margin: 0;
        color: var(--color-muted);
        font-size: 0.72rem;
        font-weight: 820;
        letter-spacing: 0;
        text-transform: uppercase;
      }

      .ui-page-header__headline {
        display: flex;
        min-width: 0;
        flex-wrap: wrap;
        align-items: center;
        gap: 0.55rem;
      }

      .ui-page-header__title {
        margin: 0;
        min-width: 0;
        color: var(--color-ink);
        font-family: var(--font-brand);
        font-size: 1.5rem;
        font-weight: 780;
        line-height: 1.15;
        overflow-wrap: anywhere;
      }

      .ui-page-header__count {
        display: inline-flex;
        min-width: 1.6rem;
        align-items: center;
        justify-content: center;
        border-radius: var(--radius-pill);
        background: var(--color-soft);
        color: var(--color-muted);
        padding: 0 0.45rem;
        font-size: 0.75rem;
        font-weight: 760;
      }

      .ui-page-header__meta {
        display: flex;
        min-width: 0;
        flex-wrap: wrap;
        align-items: center;
        gap: 0.5rem;
      }

      .ui-page-header__subtitle {
        display: -webkit-box;
        margin: 0;
        max-width: 72ch;
        overflow: hidden;
        color: var(--color-muted);
        font-size: 0.9rem;
        line-height: 1.5;
        -webkit-box-orient: vertical;
        -webkit-line-clamp: 2;
      }

      .ui-page-header__actions {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        justify-content: flex-end;
        gap: 0.5rem;
      }

      .ui-page-header--compact .ui-page-header__heading {
        gap: 0.75rem;
      }

      .ui-page-header--compact .ui-page-header__before {
        width: 2.15rem;
        height: 2.15rem;
      }

      .ui-page-header--compact .ui-page-header__title {
        font-size: 1.32rem;
      }

      .ui-page-header--compact .ui-page-header__subtitle {
        font-size: 0.88rem;
      }

      @media (min-width: 920px) {
        .ui-page-header {
          grid-template-columns: minmax(0, 1fr) auto;
          align-items: end;
        }
      }

      @media (max-width: 919px) {
        .ui-page-header__actions {
          justify-content: flex-start;
        }
      }
    `,
  ],
})
export class UiPageHeaderComponent {
  readonly title = input.required<string>();
  readonly subtitle = input<string>();
  readonly eyebrow = input<string>();
  readonly backLabel = input<string>();
  readonly backLink = input<string | unknown[] | null>(null);
  readonly density = input<'default' | 'compact'>('default');
  readonly divider = input(true);
  readonly beforeSurface = input(true);
  readonly count = input<number | null>();
}
