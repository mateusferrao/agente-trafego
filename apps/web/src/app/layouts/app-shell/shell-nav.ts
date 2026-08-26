import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { Router, RouterLink, RouterLinkActive } from '@angular/router';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucideLogOut,
  lucideBanknote,
  lucideBuilding2,
  lucideCircleCheck,
  lucideSettings,
  lucideMonitor,
  lucideHouse,
  lucideMoon,
  lucideLayoutGrid,
  lucideLayoutDashboard,
  lucideSun,
} from '@ng-icons/lucide';
import { OrgApiService } from '@core/api/org-api.service';
import type { OrgOutput } from '@core/api';
import { AuthStore } from '@core/auth';
import { ThemeStore } from '@core/theme/theme.store';
import type { ThemePreference } from '@core/theme/theme.store';
import { APP_MODULE_GROUPS, type AppModule } from '@core/navigation/app-modules';

interface ThemeOption {
  readonly value: ThemePreference;
  readonly icon: string;
  readonly label: string;
}

const THEME_OPTIONS: readonly ThemeOption[] = [
  { value: 'light', icon: 'lucideSun', label: 'Tema claro' },
  { value: 'dark', icon: 'lucideMoon', label: 'Tema escuro' },
  { value: 'system', icon: 'lucideMonitor', label: 'Tema do sistema' },
];

/**
 * Conteúdo da navegação do shell (org switcher + nav tipada + tema + usuário/sair) —
 * extraído do `AppShell` pra renderizar tanto no rail fixo (desktop) quanto dentro do
 * drawer (mobile) sem duplicar estado (fetch de orgs, logout). Nav ativa usa emerald
 * como estado de seleção (DESIGN.md §5).
 */
@Component({
  selector: 'app-shell-nav',
  changeDetection: ChangeDetectionStrategy.OnPush,
  // host = flex column que preenche a altura do container (rail desktop / corpo do
  // drawer mobile, ambos já de altura definida) — sem isso o `flex-1` do <nav> abaixo
  // não tinha o que crescer, e o bloco de tema+usuário ficava colado ao conteúdo em
  // vez de ancorado no rodapé.
  host: { class: 'flex min-h-0 flex-1 flex-col gap-5' },
  imports: [RouterLink, RouterLinkActive, NgIcon],
  providers: [
    provideIcons({
      lucideHouse,
      lucideLayoutGrid,
      lucideCircleCheck,
      lucideLayoutDashboard,
      lucideSettings,
      lucideLogOut,
      lucideBanknote,
      lucideBuilding2,
      lucideSun,
      lucideMoon,
      lucideMonitor,
    }),
  ],
  template: `
    <!-- Troca de organização (única no MVP; wired a GET /api/orgs) -->
    <div class="flex items-center gap-2.5 rounded-md border border-line bg-soft/60 px-3 py-2">
      <span class="grid size-8 shrink-0 place-items-center rounded-md bg-accent-soft text-accent-strong">
        <ng-icon name="lucideBuilding2" size="16" aria-hidden="true" />
      </span>
      <span class="flex min-w-0 flex-col">
        <span class="truncate text-sm font-semibold text-ink">{{ orgLabel() }}</span>
      </span>
    </div>

    <nav class="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto">
      @for (group of groups; track group.id; let last = $last) {
        <!-- Último grupo (Configurar) desce e cola no rodapé da nav. -->
        <div class="flex flex-col gap-1" [class.mt-auto]="last">
          <span class="px-2 text-[11px] font-semibold uppercase tracking-wide text-muted">
            {{ group.label }}
          </span>
          @for (mod of visibleModules(group.modules); track mod.id) {
            <a
              [routerLink]="mod.route"
              routerLinkActive="bg-accent-soft text-accent-strong"
              [routerLinkActiveOptions]="{ exact: mod.exact }"
              class="flex items-center gap-2.5 rounded-md px-2 py-2 text-sm font-medium text-muted transition hover:bg-soft hover:text-ink"
              [title]="mod.description"
            >
              <ng-icon [name]="mod.icon" size="18" aria-hidden="true" class="shrink-0" />
              <span class="truncate">{{ mod.label }}</span>
            </a>
          }
        </div>
      }
    </nav>

    <div class="flex flex-col gap-3 border-t border-line pt-4">
      <!-- Alternador de tema (claro / escuro / sistema) -->
      <div class="flex items-center gap-1 rounded-md border border-line bg-soft/60 p-1" role="group" aria-label="Tema">
        @for (option of themeOptions; track option.value) {
          <button
            type="button"
            class="flex flex-1 items-center justify-center rounded-sm px-2 py-1.5 text-muted transition hover:text-ink"
            [class.bg-panel]="theme.preference() === option.value"
            [class.text-accent-strong]="theme.preference() === option.value"
            [class.shadow-card]="theme.preference() === option.value"
            [attr.aria-pressed]="theme.preference() === option.value"
            [attr.aria-label]="option.label"
            [title]="option.label"
            (click)="theme.set(option.value)"
          >
            <ng-icon [name]="option.icon" size="16" aria-hidden="true" />
          </button>
        }
      </div>

      <!-- Usuário + sair -->
      <div class="flex items-center gap-2.5 px-1">
        <span class="grid size-8 shrink-0 place-items-center rounded-full bg-accent-soft text-xs font-semibold text-accent-strong">
          {{ initials() }}
        </span>
        <span class="flex min-w-0 flex-1 flex-col">
          <span class="truncate text-sm font-semibold text-ink">{{ userName() }}</span>
          <span class="truncate text-xs text-muted">{{ userEmail() }}</span>
        </span>
        <button
          type="button"
          class="grid size-9 shrink-0 place-items-center rounded-md border border-line text-muted transition hover:border-accent/35 hover:bg-soft hover:text-ink"
          aria-label="Sair"
          title="Sair"
          [disabled]="loggingOut()"
          (click)="logout()"
        >
          <ng-icon name="lucideLogOut" size="18" aria-hidden="true" />
        </button>
      </div>
    </div>
  `,
})
export class ShellNav {
  private readonly orgApi = inject(OrgApiService);
  private readonly authStore = inject(AuthStore);
  private readonly router = inject(Router);
  protected readonly theme = inject(ThemeStore);

  protected readonly groups = APP_MODULE_GROUPS;
  protected readonly themeOptions = THEME_OPTIONS;

  protected readonly role = this.authStore.role;
  protected readonly loggingOut = signal(false);
  private readonly orgs = signal<OrgOutput[]>([]);

  protected readonly userName = (): string => this.authStore.me()?.name ?? 'Você';
  protected readonly userEmail = (): string => this.authStore.me()?.email ?? '';

  /** Iniciais do usuário para o avatar do rodapé (fallback '?'). */
  protected readonly initials = (): string => {
    const parts = this.userName().trim().split(/\s+/u).filter(Boolean);
    const first = parts[0]?.[0] ?? '';
    const last = parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? '') : '';
    return (first + last).toUpperCase() || '?';
  };

  protected readonly orgLabel = (): string => {
    const current = this.authStore.me();
    if (current?.orgName) {
      return current.orgName;
    }
    return this.orgs()[0]?.name ?? 'Sua organização';
  };

  constructor() {
    // Carrega as organizações do usuário (org switcher). No MVP há uma só.
    this.orgApi.listOrgs().subscribe({
      next: (orgs) => this.orgs.set(orgs),
      error: () => this.orgs.set([]),
    });
  }

  /** Filtra itens owner-only (ex: Custos) quando o usuário não é owner. */
  protected visibleModules(modules: readonly AppModule[]): readonly AppModule[] {
    if (this.role() === 'owner') return modules;
    return modules.filter((m) => !m.ownerOnly);
  }

  protected logout(): void {
    if (this.loggingOut()) {
      return;
    }
    this.loggingOut.set(true);
    this.authStore.logout().subscribe({
      next: () => void this.router.navigate(['/login']),
      error: () => {
        // logout() é best-effort e nunca propaga erro (limpa a sessão local de
        // qualquer forma); este branch é só uma rede defensiva.
        this.loggingOut.set(false);
        void this.router.navigate(['/login']);
      },
    });
  }
}
