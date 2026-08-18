import { ChangeDetectionStrategy, Component } from '@angular/core';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { APP_MODULE_GROUPS } from '../../core/navigation/app-modules';

// Shell autenticado: sidebar persistente (nav tipada de core/navigation) + área
// de conteúdo com router-outlet. Nav ativa usa emerald (DESIGN.md §5 Navigation).
//
// TODO(vendoring): trocar este markup por <ui-module-sidebar> quando os
// componentes de shared/ui forem vendorizados (ver shared/ui/VENDORING.md).
@Component({
  selector: 'app-shell',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterOutlet, RouterLink, RouterLinkActive],
  template: `
    <div class="grid min-h-screen grid-cols-[240px_1fr] bg-app text-ink">
      <aside class="flex flex-col gap-6 border-r border-line bg-panel px-4 py-6">
        <div class="px-2">
          <span class="font-brand text-lg font-bold text-ink">Agente de Tráfego</span>
        </div>

        <nav class="flex flex-col gap-6">
          @for (group of groups; track group.id) {
            <div class="flex flex-col gap-1">
              <span class="px-2 text-xs uppercase tracking-wide text-muted">{{ group.label }}</span>
              @for (mod of group.modules; track mod.id) {
                <a
                  [routerLink]="mod.route"
                  routerLinkActive="bg-accent-soft text-accent-strong"
                  class="rounded-md px-2 py-1.5 text-sm font-medium text-ink hover:bg-soft"
                  [title]="mod.description"
                >
                  {{ mod.label }}
                </a>
              }
            </div>
          }
        </nav>
      </aside>

      <main class="min-w-0 overflow-y-auto px-8 py-8">
        <router-outlet />
      </main>
    </div>
  `,
})
export class AppShell {
  protected readonly groups = APP_MODULE_GROUPS;
}
