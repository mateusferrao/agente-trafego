import { HttpErrorResponse } from '@angular/common/http';
import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import { FormControl, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { UiButton, UiFormField, UiInput, UiSpinner } from '@ui';
import { AuthStore } from '@core/auth';

const CODE_LENGTH = 6;

/**
 * Tela de código de verificação de email (6b). Vem do signup (reason=signup) ou de
 * um login com email não-verificado (reason=verify). Confirma o código → sessão.
 */
@Component({
  selector: 'app-verify-email-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ReactiveFormsModule, RouterLink, UiButton, UiInput, UiFormField, UiSpinner],
  template: `
    <section class="rounded-lg border border-line bg-panel p-6 shadow-card sm:p-8">
      <header class="mb-6 flex flex-col gap-1.5">
        <h1 class="font-brand text-xl font-bold text-ink">Código de acesso</h1>
        <p class="text-sm text-muted">{{ subheading() }}</p>
      </header>

      <form class="flex flex-col gap-4" [formGroup]="form" (ngSubmit)="submit()">
        <app-ui-form-field label="Código de 6 dígitos" [error]="codeError()">
          <input
            appInput
            type="text"
            inputmode="numeric"
            autocomplete="one-time-code"
            maxlength="6"
            formControlName="code"
            placeholder="000000"
          />
        </app-ui-form-field>

        @if (formError()) {
          <p class="rounded-md border border-line bg-danger-soft/50 px-3 py-2 text-sm text-danger-strong">
            {{ formError() }}
          </p>
        }

        <button appButton variant="primary" type="submit" class="mt-1 w-full" [disabled]="isSubmitting()">
          @if (isSubmitting()) {
            <app-ui-spinner [size]="18" [stroke]="2" />
          }
          Confirmar
        </button>
      </form>

      <p class="mt-4 text-center text-sm text-muted">
        Não recebeu?
        <button type="button" class="font-medium text-accent-strong hover:underline" [disabled]="resending()" (click)="resend()">
          Reenviar código
        </button>
        @if (resent()) {
          <span class="ml-1 text-success-strong">enviado</span>
        }
      </p>

      <p class="mt-6 text-center text-sm text-muted">
        <a routerLink="/login" class="font-semibold text-accent-strong hover:underline">Voltar para entrar</a>
      </p>
    </section>
  `,
})
export class VerifyEmailPage {
  private readonly authStore = inject(AuthStore);
  private readonly router = inject(Router);

  /** Bindados de query params (withComponentInputBinding). */
  readonly email = input<string>('');
  readonly reason = input<string>('signup');

  protected readonly isSubmitting = signal(false);
  protected readonly resending = signal(false);
  protected readonly resent = signal(false);
  protected readonly formError = signal<string | null>(null);

  protected readonly form = new FormGroup({
    code: new FormControl('', {
      nonNullable: true,
      validators: [Validators.required, Validators.minLength(CODE_LENGTH), Validators.maxLength(CODE_LENGTH)],
    }),
  });

  protected readonly subheading = computed(() =>
    this.reason() === 'signup'
      ? 'Criamos sua conta. Digite o código enviado para confirmar seu email.'
      : 'Confirme seu email com o código que enviamos.',
  );

  protected codeError(): string | null {
    const c = this.form.controls.code;
    if (!c.invalid || !(c.touched || c.dirty)) return null;
    return 'Digite o código de 6 dígitos.';
  }

  protected submit(): void {
    this.formError.set(null);
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }
    this.isSubmitting.set(true);
    this.authStore.verifyEmailCode({ email: this.email(), code: this.form.controls.code.value.trim() }).subscribe({
      next: () => {
        this.isSubmitting.set(false);
        // sessão criada; o guard do shell leva ao muro se o acesso ainda estiver pendente.
        void this.router.navigateByUrl('/');
      },
      error: (error: unknown) => {
        this.isSubmitting.set(false);
        this.formError.set(this.friendlyMessage(error));
      },
    });
  }

  protected resend(): void {
    if (!this.email()) return;
    this.resending.set(true);
    this.resent.set(false);
    this.authStore.requestEmailCode({ email: this.email() }).subscribe({
      next: () => {
        this.resending.set(false);
        this.resent.set(true);
      },
      error: () => this.resending.set(false),
    });
  }

  private friendlyMessage(error: unknown): string {
    if (error instanceof HttpErrorResponse) {
      if (error.status === 0) return 'Sem conexão com o servidor. Tente de novo.';
      if (error.status === 400) return 'Código inválido ou expirado. Peça um novo.';
    }
    return 'Não foi possível confirmar agora. Tente novamente em instantes.';
  }
}
