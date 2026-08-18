import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { RouterLink, RouterLinkActive } from '@angular/router';
import { NgIcon } from '@ng-icons/core';

export type UiModuleSidebarItem = {
  label: string;
  route: string | unknown[];
  icon?: string;
  badge?: string | number | null;
  exact?: boolean;
  disabled?: boolean;
  id?: string;
};

@Component({
  selector: 'app-ui-module-sidebar',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [NgIcon, RouterLink, RouterLinkActive],
  host: {
    class: 'block h-full min-h-0',
  },
  template: `
    <aside class="module-sidebar" [attr.aria-label]="ariaLabel()">
      <div class="module-sidebar__header">
        <ng-content select="[sidebarHeader]" />
      </div>

      <nav class="module-sidebar__nav">
        @for (item of items(); track item.id ?? item.label) {
          <a
            class="module-sidebar__link"
            [class.module-sidebar__link--disabled]="item.disabled"
            [routerLink]="item.route"
            routerLinkActive="module-sidebar__link--active"
            [routerLinkActiveOptions]="{ exact: item.exact ?? true }"
            [attr.aria-disabled]="item.disabled ? 'true' : null"
            [attr.tabindex]="item.disabled ? -1 : null"
            (click)="item.disabled && $event.preventDefault()"
          >
            @if (item.icon) {
              <ng-icon [name]="item.icon" size="18" aria-hidden="true" class="shrink-0" />
            }

            <span class="module-sidebar__label">{{ item.label }}</span>

            @if (item.badge !== undefined && item.badge !== null && item.badge !== '') {
              <span class="module-sidebar__badge">{{ item.badge }}</span>
            }
          </a>
        }
      </nav>

      <div class="module-sidebar__footer">
        <ng-content select="[sidebarFooter]" />
      </div>
    </aside>
  `,
  styles: [
    `
      :host {
        min-height: 0;
      }

      .module-sidebar {
        display: grid;
        grid-template-rows: auto minmax(0, 1fr) auto;
        align-self: stretch;
        height: 100%;
        min-height: 0;
        gap: 0.5rem;
        border: 1px solid var(--color-line);
        border-radius: var(--radius-lg);
        background:
          linear-gradient(
            180deg,
            color-mix(in oklch, var(--color-soft) 86%, var(--color-panel)),
            color-mix(in oklch, var(--color-soft) 72%, var(--color-panel))
        );
        box-shadow: inset 0 1px 0 color-mix(in oklch, white 55%, transparent);
        padding: 0.375rem;
      }

      .module-sidebar__header:empty,
      .module-sidebar__footer:empty {
        display: none;
      }

      .module-sidebar__header,
      .module-sidebar__footer {
        min-width: 0;
      }

      .module-sidebar__footer {
        border-top: 1px solid var(--color-line);
        padding-top: 0.5rem;
      }

      .module-sidebar__nav {
        display: flex;
        min-height: 0;
        min-width: 0;
        gap: 0.125rem;
        overflow-x: auto;
        overflow-y: hidden;
        padding-bottom: 0.125rem;
        scrollbar-width: thin;
      }

      .module-sidebar__link {
        display: inline-flex;
        min-height: 2.25rem;
        min-width: 0;
        flex: 0 0 auto;
        align-items: center;
        gap: 0.625rem;
        border: 1px solid transparent;
        border-radius: var(--radius-md);
        color: var(--color-muted);
        padding: 0.45rem 0.5rem;
        text-decoration: none;
        transition:
          border-color 150ms ease,
          background-color 150ms ease,
          color 150ms ease;
      }

      .module-sidebar__link:hover {
        background: color-mix(in oklch, var(--color-ink) 4%, transparent);
        color: var(--color-ink);
      }

      .module-sidebar__link:focus-visible {
        outline: 3px solid color-mix(in oklch, var(--color-accent) 30%, transparent);
        outline-offset: 2px;
      }

      .module-sidebar__link--active,
      .module-sidebar__link--active:hover {
        border-color: transparent;
        background: color-mix(in oklch, var(--color-accent) 13%, transparent);
        color: var(--color-accent-strong);
      }

      .module-sidebar__link--active .module-sidebar__badge {
        background: var(--color-panel);
        color: var(--color-accent-strong);
      }

      .module-sidebar__link--disabled {
        cursor: not-allowed;
        opacity: 0.5;
      }

      .module-sidebar__label {
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        font-size: 0.875rem;
        font-weight: 500;
      }

      .module-sidebar__badge {
        display: inline-flex;
        min-width: 1.35rem;
        align-items: center;
        justify-content: center;
        border-radius: var(--radius-pill);
        background: var(--color-panel);
        color: var(--color-muted);
        padding: 0 0.4rem;
        font-size: 0.7rem;
        font-weight: 650;
        margin-left: auto;
      }

      @media (min-width: 1024px) {
        .module-sidebar__nav {
          flex-direction: column;
          overflow-x: hidden;
          overflow-y: auto;
          padding-bottom: 0;
        }

        .module-sidebar__link {
          width: 100%;
        }
      }
    `,
  ],
})
export class UiModuleSidebarComponent {
  readonly ariaLabel = input('Navegacao do modulo');
  readonly items = input.required<readonly UiModuleSidebarItem[]>();
}
