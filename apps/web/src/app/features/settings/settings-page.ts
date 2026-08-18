import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormControl, ReactiveFormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { toast } from 'ngx-sonner';
import { UiBadge, UiButton, UiFormField, UiInput, UiPageHeader } from '@ui';
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
 * Configurações da conta e da organização. Fatia 1a: Perfil (dados do usuário),
 * Organização (nome + renomear — stub), Tema (claro/escuro/sistema) e Acesso
 * (status do beta como tom + texto). Inclui a ação de sair.
 */
@Component({
  selector: 'app-settings-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ReactiveFormsModule, UiBadge, UiButton, UiFormField, UiInput, UiPageHeader],
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
        <form class="flex items-end gap-3" (ngSubmit)="saveOrgName()">
          <app-ui-form-field label="Nome da organização" class="flex-1">
            <input appInput type="text" [formControl]="orgNameControl" autocomplete="organization" />
          </app-ui-form-field>
          <button appButton variant="secondary" type="submit">Salvar</button>
        </form>
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
  protected readonly loggingOut = signal(false);

  protected readonly userName = (): string => this.authStore.me()?.name ?? '—';
  protected readonly userEmail = (): string => this.authStore.me()?.email ?? '—';

  protected readonly orgNameControl = new FormControl(this.authStore.orgName() ?? '', {
    nonNullable: true,
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
  }

  protected saveOrgName(): void {
    // Renomear organização ainda não tem endpoint na Fatia 1a — placeholder honesto.
    toast.info('Em breve', {
      description: 'Renomear a organização estará disponível em uma próxima atualização.',
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
