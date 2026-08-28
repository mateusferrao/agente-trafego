import { ChangeDetectionStrategy, Component, computed, effect, inject, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { NavigationEnd, Router, RouterOutlet } from '@angular/router';
import { filter } from 'rxjs';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideMenu, lucideX } from '@ng-icons/lucide';
import { UiConfirmDialogOutlet, UiDrawer, UiDrawerBody, UiDrawerHeader, UiDrawerOverlay } from '@ui';
import { APP_MODULES } from '@core/navigation/app-modules';
import { ShellNav } from './shell-nav';

/**
 * Shell autenticado: rail de nav persistente no desktop (≥md), hambúrguer + drawer
 * no mobile (o conteúdo da nav em si — org switcher/tema/logout — vive em `ShellNav`,
 * reusado nos 2 lugares sem duplicar estado). Drawer fecha sozinho a cada navegação.
 */
@Component({
  selector: 'app-shell',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterOutlet, NgIcon, UiConfirmDialogOutlet, UiDrawer, UiDrawerOverlay, UiDrawerHeader, UiDrawerBody, ShellNav],
  providers: [provideIcons({ lucideMenu, lucideX })],
  template: `
    <!-- Desktop: altura fixa + overflow-hidden → o <main> vira o container de scroll
         (habilita 'sticky' de barras de ação). Mobile: rola a janela (comportamento padrão). -->
    <div class="grid min-h-dvh grid-cols-1 content-start bg-app text-ink md:h-dvh md:grid-cols-[260px_1fr] md:content-normal md:overflow-hidden">
      <!-- Header mobile-only: hambúrguer + nome da seção atual (some no desktop, onde o rail já
           orienta). sticky top-0: mobile rola a JANELA (comment acima), então sem sticky o header
           sumiria ao descer a página — fica fixo no topo, acima do conteúdo (z-40 < z-50 do drawer). -->
      <header class="sticky top-0 z-40 flex items-center gap-3 border-b border-line bg-panel px-4 py-3 md:hidden">
        <button
          type="button"
          class="grid size-9 shrink-0 place-items-center rounded-md border border-line text-muted transition hover:border-accent/35 hover:bg-soft hover:text-ink"
          aria-label="Abrir menu"
          title="Abrir menu"
          (click)="drawerOpen.set(true)"
        >
          <ng-icon name="lucideMenu" size="20" aria-hidden="true" />
        </button>
        <span class="truncate text-sm font-semibold text-ink">{{ currentModuleLabel() }}</span>
      </header>

      <aside class="surface-noise hidden flex-col gap-5 border-r border-line bg-panel px-4 py-5 md:flex">
        <div class="brand-lockup px-1">
          <span class="brand-mark" aria-hidden="true"></span>
          <span class="brand-wordmark">Caqui<span class="text-accent">AI</span></span>
        </div>
        <app-shell-nav />
      </aside>

      @if (drawerOpen()) {
        <div appUiDrawerOverlay side="left" (click)="drawerOpen.set(false)">
          <div appUiDrawer side="left" (click)="$event.stopPropagation()">
            <div appUiDrawerHeader>
              <div class="brand-lockup px-1">
                <span class="brand-mark" aria-hidden="true"></span>
                <span class="brand-wordmark">Caqui<span class="text-accent">AI</span></span>
              </div>
              <button
                type="button"
                class="grid size-9 shrink-0 place-items-center rounded-md border border-line text-muted transition hover:border-accent/35 hover:bg-soft hover:text-ink"
                aria-label="Fechar menu"
                title="Fechar menu"
                (click)="drawerOpen.set(false)"
              >
                <ng-icon name="lucideX" size="18" aria-hidden="true" />
              </button>
            </div>
            <div appUiDrawerBody class="flex flex-col gap-5">
              <app-shell-nav />
            </div>
          </div>
        </div>
      }

      <main class="min-w-0 overflow-y-auto px-6 py-8 md:px-10">
        <router-outlet />
      </main>
    </div>

    <app-confirm-dialog-outlet />
  `,
})
export class AppShell {
  private readonly router = inject(Router);
  private readonly navigationEnd = toSignal(
    this.router.events.pipe(filter((e): e is NavigationEnd => e instanceof NavigationEnd)),
  );

  protected readonly drawerOpen = signal(false);

  protected readonly currentModuleLabel = computed(() => {
    this.navigationEnd();
    const url = this.router.url;
    const match = APP_MODULES.find((m) => (m.exact ? url === m.route : url.startsWith(m.route)));
    return match?.label ?? 'CaquiAI';
  });

  constructor() {
    // Fecha o drawer sozinho a cada navegação (usuário tocou num item do menu).
    effect(() => {
      this.navigationEnd();
      this.drawerOpen.set(false);
    });
  }
}
