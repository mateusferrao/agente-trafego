import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucideTriangleAlert,
  lucideInfo,
  lucideShieldAlert,
  lucideX,
} from '@ng-icons/lucide';
import { UiButton } from './ui-button';
import { UiDialog, UiDialogDescription, UiDialogOverlay, UiDialogTitle } from './ui-dialog';
import { UiConfirmDialogService } from './ui-confirm-dialog.service';

@Component({
  selector: 'app-confirm-dialog-outlet',
  imports: [NgIcon, UiButton, UiDialog, UiDialogDescription, UiDialogOverlay, UiDialogTitle],
  providers: [
    provideIcons({
      lucideTriangleAlert,
      lucideInfo,
      lucideShieldAlert,
      lucideX,
    }),
  ],
  template: `
    @if (confirm.request(); as request) {
      <div appDialogOverlay>
        <section
          appDialog
          class="!w-[min(23rem,calc(100vw-3rem))] !max-w-[23rem] !p-4"
          aria-labelledby="confirm-dialog-title"
          aria-describedby="confirm-dialog-description"
          [ngpDialogModal]="true"
        >
          <div class="flex items-start gap-4">
            <div
              class="grid size-10 shrink-0 place-items-center rounded-lg border"
              [class.border-danger-soft]="request.tone === 'danger'"
              [class.bg-danger-soft]="request.tone === 'danger'"
              [class.text-danger]="request.tone === 'danger'"
              [class.border-accent-soft]="request.tone !== 'danger'"
              [class.bg-accent-soft]="request.tone !== 'danger'"
              [class.text-accent-strong]="request.tone !== 'danger'"
              aria-hidden="true"
            >
              <ng-icon [name]="iconName()" size="20" />
            </div>

            <div class="min-w-0 flex-1">
              <div class="flex items-start justify-between gap-3">
                <h2 appDialogTitle id="confirm-dialog-title" class="text-base">
                  {{ request.title }}
                </h2>
                <button
                  appButton
                  type="button"
                  variant="ghost"
                  size="sm"
                  (click)="confirm.cancelActive()"
                  aria-label="Fechar confirmação"
                >
                  <ng-icon name="lucideX" size="16" aria-hidden="true" />
                </button>
              </div>

              @if (request.description) {
                <p appDialogDescription id="confirm-dialog-description">
                  {{ request.description }}
                </p>
              } @else {
                <p appDialogDescription id="confirm-dialog-description">Confirme para continuar.</p>
              }
            </div>
          </div>

          <div class="mt-5 flex justify-end gap-2">
            <button appButton type="button" variant="secondary" (click)="confirm.cancelActive()">
              {{ request.cancelLabel }}
            </button>
            <button
              appButton
              type="button"
              [variant]="request.tone === 'danger' ? 'danger' : 'primary'"
              (click)="confirm.confirmActive()"
            >
              {{ request.confirmLabel }}
            </button>
          </div>
        </section>
      </div>
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class UiConfirmDialogOutletComponent {
  readonly confirm = inject(UiConfirmDialogService);

  readonly iconName = computed(() => {
    const tone = this.confirm.request()?.tone;
    if (tone === 'danger') return 'lucideShieldAlert';
    if (tone === 'warning') return 'lucideTriangleAlert';
    return 'lucideInfo';
  });
}
