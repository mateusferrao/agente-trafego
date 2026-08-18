import { Routes } from '@angular/router';
import { authGuard, guestOnlyGuard } from '@core/auth';

// Árvore de rotas top-level. Tudo lazy (standalone loadComponent) para o bundle
// inicial enxuto. O AppShell (path '') vem PRIMEIRO para que '/' resolva no shell,
// que redireciona para '/accounts' (landing); '/login' e '/signup' não casam filho
// do shell e caem no auth-layout (path '') logo abaixo. Guards: authGuard (anônimo →
// /login) no shell/onboarding; guestOnlyGuard (logado → shell) nas rotas públicas.
// Ver docs/DESIGN.md (IA).
export const routes: Routes = [
  {
    path: '',
    canActivate: [authGuard],
    canActivateChild: [authGuard],
    loadComponent: () => import('./layouts/app-shell/app-shell').then((m) => m.AppShell),
    children: [
      { path: '', pathMatch: 'full', redirectTo: 'accounts' },
      {
        path: 'accounts',
        title: 'Contas — Agente de Tráfego',
        loadComponent: () => import('./features/accounts/accounts-page').then((m) => m.AccountsPage),
      },
      {
        path: 'approvals',
        title: 'Aprovações — Agente de Tráfego',
        loadComponent: () =>
          import('./features/approvals/approvals-page').then((m) => m.ApprovalsPage),
      },
      {
        path: 'integrations',
        title: 'Integrações — Agente de Tráfego',
        loadComponent: () =>
          import('./features/integrations/integrations-page').then((m) => m.IntegrationsPage),
      },
      {
        path: 'settings',
        title: 'Configurações — Agente de Tráfego',
        loadComponent: () =>
          import('./features/settings/settings-page').then((m) => m.SettingsPage),
      },
    ],
  },
  {
    path: 'onboarding',
    canActivate: [authGuard],
    title: 'Onboarding — Agente de Tráfego',
    loadComponent: () =>
      import('./features/onboarding/onboarding-page').then((m) => m.OnboardingPage),
  },
  {
    path: '',
    canActivateChild: [guestOnlyGuard],
    loadComponent: () =>
      import('./layouts/auth-layout/auth-layout').then((m) => m.AuthLayoutComponent),
    children: [
      {
        path: 'login',
        title: 'Entrar — Agente de Tráfego',
        data: { mode: 'login' },
        loadComponent: () => import('./features/login/login-page').then((m) => m.LoginPage),
      },
      {
        path: 'signup',
        title: 'Criar conta — Agente de Tráfego',
        data: { mode: 'signup' },
        loadComponent: () => import('./features/login/login-page').then((m) => m.LoginPage),
      },
    ],
  },
  { path: '**', redirectTo: '' },
];
