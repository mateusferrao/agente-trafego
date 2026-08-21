import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { FormControl, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { UiButton, UiFormField, UiInput, UiSpinner } from '@ui';
import { AuthStore } from '@core/auth';

/**
 * "Esqueci minha senha" (6b): pede o email → o backend manda o link (sempre 204,
 * anti-enumeração). Mostra sempre a mesma confirmação, exista a conta ou não.
 */
@Component({
  selector: 'app-forgot-password-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ReactiveFormsModule, RouterLink, UiButton, UiInput, UiFormField, UiSpinner],
  template: `
    <section class="rounded-lg border border-line bg-panel p-6 shadow-card sm:p-8">
      @if (sent()) {
        <header class="mb-4 flex flex-col gap-1.5">
          <h1 class="font-brand text-xl font-bold text-ink">Verifique seu email</h1>
          <p class="text-sm text-muted">
            Se existir uma conta com esse email, enviamos um link para redefinir a senha. O link expira em breve.
          </p>
        </header>
        <a appButton variant="secondary" routerLink="/login" class="w-full">Voltar para entrar</a>
      } @else {
        <header class="mb-6 flex flex-col gap-1.5">
          <h1 class="font-brand text-xl font-bold text-ink">Redefinir senha</h1>
          <p class="text-sm text-muted">Informe seu email e enviaremos um link para criar uma nova senha.</p>
        </header>

        <form class="flex flex-col gap-4" [formGroup]="form" (ngSubmit)="submit()">
          <app-ui-form-field label="E-mail" [error]="emailError()">
            <input appInput type="email" formControlName="email" autocomplete="email" placeholder="voce@empresa.com" />
          </app-ui-form-field>

          <button appButton variant="primary" type="submit" class="mt-1 w-full" [disabled]="isSubmitting()">
            @if (isSubmitting()) {
              <app-ui-spinner [size]="18" [stroke]="2" />
            }
            Enviar link
          </button>
        </form>

        <p class="mt-6 text-center text-sm text-muted">
          <a routerLink="/login" class="font-semibold text-accent-strong hover:underline">Voltar para entrar</a>
        </p>
      }
    </section>
  `,
})
export class ForgotPasswordPage {
  private readonly authStore = inject(AuthStore);

  protected readonly isSubmitting = signal(false);
  protected readonly sent = signal(false);

  protected readonly form = new FormGroup({
    email: new FormControl('', {
      nonNullable: true,
      validators: [Validators.required, Validators.email],
    }),
  });

  protected emailError(): string | null {
    const c = this.form.controls.email;
    if (!c.invalid || !(c.touched || c.dirty)) return null;
    return 'Informe um e-mail válido.';
  }

  protected submit(): void {
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }
    this.isSubmitting.set(true);
    // sempre resolve na mesma tela (anti-enum): sucesso OU erro → confirmação.
    this.authStore.forgotPassword({ email: this.form.controls.email.value.trim() }).subscribe({
      next: () => {
        this.isSubmitting.set(false);
        this.sent.set(true);
      },
      error: () => {
        this.isSubmitting.set(false);
        this.sent.set(true);
      },
    });
  }
}
