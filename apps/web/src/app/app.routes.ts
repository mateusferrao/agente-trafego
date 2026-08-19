import { Routes } from '@angular/router';
import { authGuard, guestOnlyGuard } from '@core/auth';

// Árvore de rotas top-level. Tudo lazy (standalone loadComponent) para o bundle
// inicial enxuto. O AppShell (path '') vem PRIMEIRO para que '/' resolva no shell,
// que redireciona para '/accounts' (landing); '/login' e '/signup' não casam filho
// do shell e caem no auth-layout (path '') logo abaixo. Guards: authGuard (anônimo →
// /login) no shell; guestOnlyGuard (logado → shell) nas rotas públicas.
// Onboarding (conectar conta) = connect-dialog disparado do /accounts, não uma rota.
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
        path: 'accounts/:id',
        title: 'Conta — Agente de Tráfego',
        loadComponent: () =>
          import('./features/account-detail/account-detail-page').then((m) => m.AccountDetailPage),
      },
      {
        path: 'accounts/:id/agente',
        title: 'Configurar agente — Agente de Tráfego',
        loadComponent: () =>
          import('./features/agent-config/agent-config-page').then((m) => m.AgentConfigPage),
      },
      {
        path: 'accounts/:id/runs/:runId',
        title: 'Análise — Agente de Tráfego',
        loadComponent: () =>
          import('./features/run-detail/run-detail-page').then((m) => m.RunDetailPage),
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
      // WhatsApp deixou de ser aba (virou integração em Integrações — docs/DESIGN.md).
      // Redirect preserva links antigos.
      { path: 'whatsapp', pathMatch: 'full', redirectTo: 'integrations' },
      {
        path: 'settings',
        title: 'Configurações — Agente de Tráfego',
        loadComponent: () =>
          import('./features/settings/settings-page').then((m) => m.SettingsPage),
      },
    ],
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
