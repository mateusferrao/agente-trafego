import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormControl, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import { Router } from '@angular/router';
import { toast } from 'ngx-sonner';
import { UiBadge, UiButton, UiFormField, UiInput, UiPageHeader, UiSelectBox } from '@ui';
import { AuthStore } from '@core/auth';
import { OrgApiService } from '@core/api/org-api.service';
import type { AccessStatusOutputStatusEnumKey as AccessStatus } from '@core/api/generated';
import { ThemeStore } from '@core/theme/theme.store';
import type { ThemePreference } from '@core/theme/theme.store';

type BadgeTone = 'success' | 'warning' | 'danger' | 'neutral';

interface AccessBadge {
  readonly tone: BadgeTone;
  readonly text: string;
  readonly hint: string;
}

interface ThemeChoice {
  readonly value: ThemePreference;
  readonly label: string;
}

const THEME_CHOICES: readonly ThemeChoice[] = [
  { value: 'light', label: 'Claro' },
  { value: 'dark', label: 'Escuro' },
  { value: 'system', label: 'Sistema' },
];

/** Fusos oferecidos (BR-first + alguns globais). IANA tz. Usado na cadência das análises. */
const TIMEZONES: readonly { value: string; label: string }[] = [
  { value: 'America/Sao_Paulo', label: 'São Paulo / Brasília (BRT)' },
  { value: 'America/Manaus', label: 'Manaus (AMT)' },
  { value: 'America/Belem', label: 'Belém' },
  { value: 'America/Fortaleza', label: 'Fortaleza' },
  { value: 'America/Recife', label: 'Recife' },
  { value: 'America/Bahia', label: 'Salvador' },
  { value: 'America/Cuiaba', label: 'Cuiabá' },
  { value: 'America/Campo_Grande', label: 'Campo Grande' },
  { value: 'America/Rio_Branco', label: 'Rio Branco (ACT)' },
  { value: 'America/Noronha', label: 'Fernando de Noronha' },
  { value: 'UTC', label: 'UTC' },
  { value: 'America/New_York', label: 'Nova York (ET)' },
  { value: 'Europe/Lisbon', label: 'Lisboa' },
];

// Status = tom + texto, nunca cor sozinha (DESIGN.md §6).
const ACCESS_BADGE: Record<AccessStatus, AccessBadge> = {
  active: { tone: 'success', text: 'Ativo', hint: 'Seu acesso ao beta está liberado.' },
  pending: {
    tone: 'warning',
    text: 'Aguardando liberação',
    hint: 'Seu acesso está na fila do beta. Avisamos assim que liberar.',
  },
  revoked: {
    tone: 'danger',
    text: 'Revogado',
    hint: 'Seu acesso ao beta foi revogado. Fale com o suporte.',
  },
};

/**
 * Configurações da conta e da organização: Perfil (dados do usuário),
 * Organização (renomear — só owner), Tema (claro/escuro/sistema) e Acesso
 * (status do beta como tom + texto). Inclui a ação de sair.
 */
@Component({
  selector: 'app-settings-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ReactiveFormsModule, UiBadge, UiButton, UiFormField, UiInput, UiPageHeader, UiSelectBox],
  template: `
    <div class="flex max-w-2xl flex-col gap-8">
      <app-ui-page-header title="Configurações" subtitle="Perfil, organização, tema e acesso." />

      <!-- Perfil -->
      <section class="flex flex-col gap-4 rounded-lg border border-line bg-panel p-5">
        <div class="flex flex-col gap-0.5">
          <h2 class="font-brand text-base font-semibold text-ink">Perfil</h2>
          <p class="text-sm text-muted">Seus dados de acesso.</p>
        </div>
        <dl class="grid gap-3 sm:grid-cols-2">
          <div class="flex flex-col gap-0.5">
            <dt class="text-xs font-medium text-muted">Nome</dt>
            <dd class="text-sm font-semibold text-ink">{{ userName() }}</dd>
          </div>
          <div class="flex flex-col gap-0.5">
            <dt class="text-xs font-medium text-muted">E-mail</dt>
            <dd class="text-sm font-semibold text-ink">{{ userEmail() }}</dd>
          </div>
        </dl>
      </section>

      <!-- Organização -->
      <section class="flex flex-col gap-4 rounded-lg border border-line bg-panel p-5">
        <div class="flex flex-col gap-0.5">
          <h2 class="font-brand text-base font-semibold text-ink">Organização</h2>
          <p class="text-sm text-muted">Nome exibido no topo do painel.</p>
        </div>
        <form class="flex items-end gap-3" [formGroup]="orgForm" (ngSubmit)="saveOrgName()">
          <app-ui-form-field label="Nome da organização" class="flex-1">
            <input appInput type="text" formControlName="name" autocomplete="organization" />
          </app-ui-form-field>
          <button appButton variant="secondary" type="submit" [disabled]="savingOrg()">
            {{ savingOrg() ? 'Salvando…' : 'Salvar' }}
          </button>
        </form>
      </section>

      <!-- Fuso horário (org) — usado na cadência das análises automáticas -->
      <section class="flex flex-col gap-4 rounded-lg border border-line bg-panel p-5">
        <div class="flex flex-col gap-0.5">
          <h2 class="font-brand text-base font-semibold text-ink">Fuso horário</h2>
          <p class="text-sm text-muted">Usado para agendar as análises automáticas dos seus agentes.</p>
        </div>
        <div class="w-full max-w-sm">
          <app-ui-select
            [options]="timezones"
            [value]="timezone()"
            [disabled]="savingTz()"
            (valueChange)="onTimezone($event)"
          />
        </div>
      </section>

      <!-- Tema -->
      <section class="flex flex-col gap-4 rounded-lg border border-line bg-panel p-5">
        <div class="flex flex-col gap-0.5">
          <h2 class="font-brand text-base font-semibold text-ink">Tema</h2>
          <p class="text-sm text-muted">Como o painel aparece para você.</p>
        </div>
        <div class="flex flex-wrap gap-2" role="group" aria-label="Tema">
          @for (choice of themeChoices; track choice.value) {
            <button
              type="button"
              class="rounded-md border px-4 py-2 text-sm font-medium transition"
              [class.border-accent]="theme.preference() === choice.value"
              [class.bg-accent-soft]="theme.preference() === choice.value"
              [class.text-accent-strong]="theme.preference() === choice.value"
              [class.border-line]="theme.preference() !== choice.value"
              [class.text-muted]="theme.preference() !== choice.value"
              [attr.aria-pressed]="theme.preference() === choice.value"
              (click)="theme.set(choice.value)"
            >
              {{ choice.label }}
            </button>
          }
        </div>
      </section>

      <!-- Acesso (beta) -->
      <section class="flex flex-col gap-3 rounded-lg border border-line bg-panel p-5">
        <div class="flex items-center justify-between gap-3">
          <h2 class="font-brand text-base font-semibold text-ink">Acesso</h2>
          <span appBadge [tone]="accessBadge().tone">{{ accessBadge().text }}</span>
        </div>
        <p class="text-sm text-muted">{{ accessBadge().hint }}</p>
      </section>

      <!-- Sair -->
      <section class="flex items-center justify-between gap-3 rounded-lg border border-line bg-panel p-5">
        <div class="flex flex-col gap-0.5">
          <h2 class="font-brand text-base font-semibold text-ink">Sessão</h2>
          <p class="text-sm text-muted">Encerrar a sessão neste dispositivo.</p>
        </div>
        <button appButton variant="secondary" type="button" [disabled]="loggingOut()" (click)="logout()">
          Sair da conta
        </button>
      </section>
    </div>
  `,
})
export class SettingsPage {
  private readonly authStore = inject(AuthStore);
  private readonly orgApi = inject(OrgApiService);
  private readonly router = inject(Router);
  protected readonly theme = inject(ThemeStore);

  protected readonly themeChoices = THEME_CHOICES;
  protected readonly timezones = TIMEZONES;
  protected readonly loggingOut = signal(false);
  protected readonly savingOrg = signal(false);
  protected readonly savingTz = signal(false);
  protected readonly timezone = signal(TIMEZONES[0]!.value); // base até currentOrg carregar

  protected readonly userName = (): string => this.authStore.me()?.name ?? '—';
  protected readonly userEmail = (): string => this.authStore.me()?.email ?? '—';

  protected readonly orgForm = new FormGroup({
    name: new FormControl(this.authStore.orgName() ?? '', {
      nonNullable: true,
      validators: [Validators.required, Validators.minLength(2)],
    }),
  });

  private readonly accessStatus = signal<AccessStatus | null>(this.authStore.accessStatus());
  protected readonly accessBadge = computed<AccessBadge>(() => {
    const status = this.accessStatus();
    return status
      ? ACCESS_BADGE[status]
      : { tone: 'neutral', text: 'Indefinido', hint: 'Não foi possível ler o status agora.' };
  });

  constructor() {
    // Confirma o status de acesso na fonte dedicada; se falhar, mantém o do MeOutput.
    this.orgApi.accessStatus().subscribe({
      next: (result) => this.accessStatus.set(result.status),
      error: () => undefined,
    });
    // Fuso atual da org (base do select).
    this.orgApi.currentOrg().subscribe({
      next: (org) => this.timezone.set(org.timezone),
      error: () => undefined,
    });
  }

  protected onTimezone(tz: string): void {
    if (tz === this.timezone() || this.savingTz()) return;
    const previous = this.timezone();
    this.timezone.set(tz);
    this.savingTz.set(true);
    this.orgApi.setTimezone(tz).subscribe({
      next: (org) => {
        this.timezone.set(org.timezone);
        this.savingTz.set(false);
        toast.success('Fuso horário atualizado');
      },
      error: () => {
        this.timezone.set(previous); // reverte a seleção otimista
        this.savingTz.set(false);
        toast.error('Não consegui salvar o fuso', { description: 'Verifique sua conexão e tente de novo.' });
      },
    });
  }

  protected saveOrgName(): void {
    if (this.savingOrg()) {
      return;
    }
    const control = this.orgForm.controls.name;
    const name = control.value.trim();
    if (this.orgForm.invalid || name.length < 2) {
      this.orgForm.markAllAsTouched();
      toast.warning('Nome muito curto', {
        description: 'Use pelo menos 2 caracteres para o nome da organização.',
      });
      return;
    }
    if (name === (this.authStore.orgName() ?? '')) {
      return; // nada mudou — não chama a API à toa.
    }

    this.savingOrg.set(true);
    this.orgApi.renameOrg({ name }).subscribe({
      next: (org) => {
        this.authStore.setOrgName(org.name);
        control.setValue(org.name);
        this.savingOrg.set(false);
        toast.success('Nome da organização atualizado');
      },
      error: () => {
        this.savingOrg.set(false);
        toast.error('Não consegui salvar o nome', {
          description: 'Verifique sua conexão e tente de novo.',
        });
      },
    });
  }

  protected logout(): void {
    if (this.loggingOut()) {
      return;
    }
    this.loggingOut.set(true);
    this.authStore.logout().subscribe({
      next: () => void this.router.navigate(['/login']),
      error: () => {
        this.loggingOut.set(false);
        void this.router.navigate(['/login']);
      },
    });
  }
}
