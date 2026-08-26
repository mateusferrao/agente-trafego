import { HttpErrorResponse } from '@angular/common/http';
import { ChangeDetectionStrategy, Component, computed, effect, inject, input, signal } from '@angular/core';
import {
  FormControl,
  FormGroup,
  ReactiveFormsModule,
  Validators,
} from '@angular/forms';
import { Router } from '@angular/router';
import { RouterLink } from '@angular/router';
import { UiButton, UiFormField, UiInput, UiSpinner } from '@ui';
import { AuthStore } from '@core/auth';
import type { LoginInput, SignupInput } from '@core/api';

export type AuthMode = 'login' | 'signup';

const PASSWORD_MIN_LENGTH = 8;
const ORG_NAME_MIN_LENGTH = 2;

/**
 * Tela pública de autenticação. Um único componente serve login e cadastro; o modo
 * vem de `route.data.mode` (bind por withComponentInputBinding). Erros aparecem
 * inline, em linguagem de gente (nunca stack/código — DESIGN.md, UX rules).
 */
@Component({
  selector: 'app-login-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ReactiveFormsModule, RouterLink, UiButton, UiInput, UiFormField, UiSpinner],
  template: `
    <section class="rounded-lg border border-line bg-panel p-6 shadow-card sm:p-8">
      <header class="mb-6 flex flex-col gap-1.5">
        <h1 class="font-brand text-xl font-bold text-ink">{{ heading() }}</h1>
        <p class="text-sm text-muted">{{ subheading() }}</p>
      </header>

      @if (reset() === '1' && !isSignup()) {
        <p class="mb-4 rounded-md border border-line bg-success-soft/50 px-3 py-2 text-sm text-success-strong">
          Senha alterada. Entre com a nova senha.
        </p>
      }

      <form class="flex flex-col gap-4" [formGroup]="form" (ngSubmit)="submit()">
        @if (isSignup()) {
          <app-ui-form-field label="Seu nome" [error]="fieldError('name')">
            <input
              appInput
              type="text"
              formControlName="name"
              autocomplete="name"
              placeholder="Como podemos te chamar"
            />
          </app-ui-form-field>
        }

        <app-ui-form-field label="E-mail" [error]="fieldError('email')">
          <input
            appInput
            type="email"
            formControlName="email"
            autocomplete="email"
            placeholder="voce@empresa.com"
          />
        </app-ui-form-field>

        <app-ui-form-field
          label="Senha"
          [error]="fieldError('password')"
          [hint]="isSignup() ? 'Mínimo de 8 caracteres.' : ''"
        >
          <input
            appInput
            type="password"
            formControlName="password"
            [autocomplete]="isSignup() ? 'new-password' : 'current-password'"
            placeholder="••••••••"
          />
        </app-ui-form-field>

        @if (isSignup()) {
          <app-ui-form-field
            label="Nome da organização"
            hint="Aparece no topo do painel. Você pode mudar depois."
            [error]="fieldError('orgName')"
          >
            <input
              appInput
              type="text"
              formControlName="orgName"
              autocomplete="organization"
              placeholder="Sua agência ou empresa"
            />
          </app-ui-form-field>
        }

        @if (formError()) {
          <p class="rounded-md border border-line bg-danger-soft/50 px-3 py-2 text-sm text-danger-strong">
            {{ formError() }}
          </p>
        }

        <button appButton variant="primary" type="submit" class="mt-1 w-full" [disabled]="isSubmitting()">
          @if (isSubmitting()) {
            <app-ui-spinner [size]="18" [stroke]="2" />
          }
          {{ submitLabel() }}
        </button>
      </form>

      @if (!isSignup()) {
        <p class="mt-3 text-center text-sm">
          <a routerLink="/forgot-password" class="font-medium text-accent-strong hover:underline">
            Esqueci minha senha
          </a>
        </p>
      }

      <p class="mt-6 text-center text-sm text-muted">
        {{ switchPrompt() }}
        <a [routerLink]="switchRoute()" class="font-semibold text-accent-strong hover:underline">
          {{ switchLabel() }}
        </a>
      </p>
    </section>
  `,
})
export class LoginPage {
  private readonly authStore = inject(AuthStore);
  private readonly router = inject(Router);

  /** Modo bindado de route.data.mode. Default seguro = login. */
  readonly mode = input<AuthMode>('login');
  /** Caminho interno para retornar após entrar (bindado de query param). */
  readonly returnTo = input<string>();
  /** '1' quando vindo do reset de senha concluído (query param) → banner de sucesso. */
  readonly reset = input<string>();

  protected readonly isSignup = computed(() => this.mode() === 'signup');
  protected readonly isSubmitting = signal(false);
  protected readonly formError = signal<string | null>(null);

  protected readonly form = new FormGroup({
    name: new FormControl('', { nonNullable: true }),
    email: new FormControl('', {
      nonNullable: true,
      validators: [Validators.required, Validators.email],
    }),
    password: new FormControl('', {
      nonNullable: true,
      validators: [Validators.required, Validators.minLength(PASSWORD_MIN_LENGTH)],
    }),
    orgName: new FormControl('', { nonNullable: true }),
  });

  constructor() {
    // Os campos de cadastro (nome/organização) só valem no modo signup — liga/desliga
    // validadores conforme o modo para o login não exigir campos que nem aparecem.
    effect(() => {
      const signup = this.isSignup();
      const name = this.form.controls.name;
      const orgName = this.form.controls.orgName;

      if (signup) {
        name.setValidators([Validators.required]);
        orgName.setValidators([Validators.required, Validators.minLength(ORG_NAME_MIN_LENGTH)]);
      } else {
        name.clearValidators();
        orgName.clearValidators();
      }
      name.updateValueAndValidity({ emitEvent: false });
      orgName.updateValueAndValidity({ emitEvent: false });
      this.formError.set(null);
    });
  }

  protected heading(): string {
    return this.isSignup() ? 'Criar sua conta' : 'Entrar';
  }

  protected subheading(): string {
    return this.isSignup()
      ? 'Poucos minutos e seu agente já começa a acompanhar as campanhas.'
      : 'Bem-vindo de volta. Entre para continuar.';
  }

  protected submitLabel(): string {
    return this.isSignup() ? 'Criar conta' : 'Entrar';
  }

  protected switchPrompt(): string {
    return this.isSignup() ? 'Já tem conta?' : 'Ainda não tem conta?';
  }

  protected switchLabel(): string {
    return this.isSignup() ? 'Entrar' : 'Criar conta';
  }

  protected switchRoute(): string {
    return this.isSignup() ? '/login' : '/signup';
  }

  protected fieldError(control: 'name' | 'email' | 'password' | 'orgName'): string | null {
    const field = this.form.controls[control];
    if (!field.invalid || !(field.touched || field.dirty)) {
      return null;
    }
    if (field.hasError('required')) {
      return 'Este campo é obrigatório.';
    }
    if (field.hasError('email')) {
      return 'Informe um e-mail válido.';
    }
    if (field.hasError('minlength')) {
      return control === 'password'
        ? 'A senha precisa de pelo menos 8 caracteres.'
        : 'Nome muito curto.';
    }
    return 'Confira este campo.';
  }

  protected submit(): void {
    this.formError.set(null);
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }

    this.isSubmitting.set(true);
    const value = this.form.getRawValue();
    const email = value.email.trim();

    if (this.isSignup()) {
      this.authStore
        .signup({
          name: value.name.trim(),
          email,
          password: value.password,
          orgName: value.orgName.trim(),
        } satisfies SignupInput)
        .subscribe({
          // Signup (6b) não autentica: manda pra tela de código de verificação.
          next: () => {
            this.isSubmitting.set(false);
            void this.router.navigate(['/verify-email'], {
              queryParams: { email, reason: 'signup' },
            });
          },
          error: (error: unknown) => {
            this.isSubmitting.set(false);
            this.formError.set(this.friendlyMessage(error));
          },
        });
      return;
    }

    this.authStore.login({ email, password: value.password } satisfies LoginInput).subscribe({
      next: () => {
        this.isSubmitting.set(false);
        void this.router.navigateByUrl(this.resolveReturnPath());
      },
      error: (error: unknown) => {
        this.isSubmitting.set(false);
        // Email não verificado → tela de código (o backend já reenviou).
        if (this.errorCode(error) === 'auth_email_not_verified') {
          void this.router.navigate(['/verify-email'], { queryParams: { email, reason: 'verify' } });
          return;
        }
        // Acesso ainda não liberado (gate de beta) → muro.
        if (this.errorCode(error) === 'access_pending') {
          void this.router.navigateByUrl('/acesso-pendente');
          return;
        }
        this.formError.set(this.friendlyMessage(error));
      },
    });
  }

  /** Código de erro tipado do backend (AppError.code), se houver. */
  private errorCode(error: unknown): string | null {
    if (error instanceof HttpErrorResponse) {
      const body = error.error as { code?: string } | null;
      return body?.code ?? null;
    }
    return null;
  }

  private resolveReturnPath(): string {
    const target = this.returnTo();
    if (!target || !target.startsWith('/') || target.startsWith('//')) {
      return '/';
    }
    return target;
  }

  private friendlyMessage(error: unknown): string {
    if (error instanceof HttpErrorResponse) {
      if (error.status === 0) {
        return 'Sem conexão com o servidor. Verifique sua internet e tente de novo.';
      }
      if (error.status === 401) {
        return 'E-mail ou senha incorretos. Confira e tente novamente.';
      }
      if (error.status === 409) {
        return 'Já existe uma conta com esse e-mail. Tente entrar.';
      }
      if (error.status === 422 || error.status === 400) {
        return 'Confira os dados informados e tente novamente.';
      }
    }
    return 'Não foi possível concluir agora. Tente novamente em instantes.';
  }
}
