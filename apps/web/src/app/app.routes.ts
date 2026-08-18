import { Routes } from '@angular/router';

// Árvore de rotas top-level. Tudo lazy (standalone loadComponent) para manter o
// bundle inicial enxuto. O onboarding fica fora do shell (fluxo guiado full-screen);
// o resto vive dentro do AppShell (nav persistente — ver DESIGN.md §5 Navigation).
export const routes: Routes = [
  {
    path: 'onboarding',
    title: 'Onboarding — Agente de Tráfego',
    loadComponent: () =>
      import('./features/onboarding/onboarding-page').then((m) => m.OnboardingPage),
  },
  {
    path: '',
    loadComponent: () => import('./layouts/app-shell/app-shell').then((m) => m.AppShell),
    children: [
      { path: '', pathMatch: 'full', redirectTo: 'timeline' },
      {
        path: 'timeline',
        title: 'Timeline — Agente de Tráfego',
        loadComponent: () =>
          import('./features/timeline/timeline-page').then((m) => m.TimelinePage),
      },
      {
        path: 'accounts',
        title: 'Contas Meta — Agente de Tráfego',
        loadComponent: () =>
          import('./features/accounts/accounts-page').then((m) => m.AccountsPage),
      },
      {
        path: 'agents',
        title: 'Agentes — Agente de Tráfego',
        loadComponent: () => import('./features/agents/agents-page').then((m) => m.AgentsPage),
      },
      {
        path: 'agents/:agentId',
        title: 'Configuração do agente — Agente de Tráfego',
        loadComponent: () => import('./features/agents/agents-page').then((m) => m.AgentsPage),
      },
      {
        path: 'settings',
        title: 'Configurações — Agente de Tráfego',
        loadComponent: () =>
          import('./features/settings/settings-page').then((m) => m.SettingsPage),
      },
    ],
  },
  { path: '**', redirectTo: '' },
];
