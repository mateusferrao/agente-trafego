import { HttpErrorResponse } from '@angular/common/http';
import { ChangeDetectionStrategy, Component, inject, input, signal } from '@angular/core';
import { FormControl, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { UiButton, UiFormField, UiInput, UiSpinner } from '@ui';
import { AuthStore } from '@core/auth';

const PASSWORD_MIN_LENGTH = 8;

/**
 * Redefinição de senha via token do link (6b). Aplica a nova senha e leva ao login
 * (o backend revoga as outras sessões). Link inválido/expirado → mensagem clara.
 */
@Component({
  selector: 'app-reset-password-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ReactiveFormsModule, RouterLink, UiButton, UiInput, UiFormField, UiSpinner],
  template: `
    <section class="rounded-lg border border-line bg-panel p-6 shadow-card sm:p-8">
      <header class="mb-6 flex flex-col gap-1.5">
        <h1 class="font-brand text-xl font-bold text-ink">Criar nova senha</h1>
        <p class="text-sm text-muted">Escolha uma nova senha para sua conta.</p>
      </header>

      @if (!token()) {
        <p class="rounded-md border border-line bg-danger-soft/50 px-3 py-2 text-sm text-danger-strong">
          Link inválido. Peça um novo em "Esqueci minha senha".
        </p>
        <a appButton variant="secondary" routerLink="/forgot-password" class="mt-4 w-full">Pedir novo link</a>
      } @else {
        <form class="flex flex-col gap-4" [formGroup]="form" (ngSubmit)="submit()">
          <app-ui-form-field label="Nova senha" hint="Mínimo de 8 caracteres, com letras e números." [error]="passwordError()">
            <input appInput type="password" formControlName="password" autocomplete="new-password" placeholder="••••••••" />
          </app-ui-form-field>

          <app-ui-form-field label="Confirmar nova senha" [error]="confirmError()">
            <input appInput type="password" formControlName="confirm" autocomplete="new-password" placeholder="••••••••" />
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
            Salvar nova senha
          </button>
        </form>
      }
    </section>
  `,
})
export class ResetPasswordPage {
  private readonly authStore = inject(AuthStore);
  private readonly router = inject(Router);

  /** Token do link (query param, bindado por withComponentInputBinding). */
  readonly token = input<string>('');

  protected readonly isSubmitting = signal(false);
  protected readonly formError = signal<string | null>(null);

  protected readonly form = new FormGroup({
    password: new FormControl('', {
      nonNullable: true,
      validators: [Validators.required, Validators.minLength(PASSWORD_MIN_LENGTH)],
    }),
    confirm: new FormControl('', { nonNullable: true, validators: [Validators.required] }),
  });

  protected passwordError(): string | null {
    const c = this.form.controls.password;
    if (!c.invalid || !(c.touched || c.dirty)) return null;
    return 'A senha precisa de pelo menos 8 caracteres.';
  }

  /** Erro de confirmação: só quando o campo foi tocado e diverge da senha. */
  protected confirmError(): string | null {
    const c = this.form.controls.confirm;
    if (!(c.touched || c.dirty)) return null;
    if (c.hasError('required')) return 'Confirme a nova senha.';
    return c.value === this.form.controls.password.value ? null : 'As senhas não conferem.';
  }

  protected submit(): void {
    this.formError.set(null);
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }
    if (this.form.controls.password.value !== this.form.controls.confirm.value) {
      this.form.controls.confirm.markAsTouched();
      return; // confirmError() exibe "As senhas não conferem."
    }
    this.isSubmitting.set(true);
    this.authStore.resetPassword({ token: this.token(), password: this.form.controls.password.value }).subscribe({
      next: () => {
        this.isSubmitting.set(false);
        void this.router.navigate(['/login'], { queryParams: { reset: '1' } });
      },
      error: (error: unknown) => {
        this.isSubmitting.set(false);
        this.formError.set(this.friendlyMessage(error));
      },
    });
  }

  private friendlyMessage(error: unknown): string {
    if (error instanceof HttpErrorResponse) {
      if (error.status === 0) return 'Sem conexão com o servidor. Tente de novo.';
      if (error.status === 400) return 'Link inválido ou expirado, ou senha fraca. Peça um novo link.';
    }
    return 'Não foi possível redefinir agora. Tente novamente em instantes.';
  }
}
