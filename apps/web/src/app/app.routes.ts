import { Routes } from '@angular/router';
import {
  activeAccessGuard,
  authGuard,
  guestOnlyGuard,
  ownerGuard,
  pendingAccessGuard,
} from '@core/auth';

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
    // authGuard = autenticado; activeAccessGuard = acesso liberado (gate de beta, 6b) →
    // usuário verificado mas pendente cai no muro /acesso-pendente.
    canActivateChild: [authGuard, activeAccessGuard],
    loadComponent: () => import('./layouts/app-shell/app-shell').then((m) => m.AppShell),
    children: [
      { path: '', pathMatch: 'full', redirectTo: 'dashboard' },
      {
        path: 'dashboard',
        title: 'Painel',
        loadComponent: () =>
          import('./features/dashboard/dashboard-page').then((m) => m.DashboardPage),
      },
      {
        path: 'accounts',
        title: 'Contas',
        loadComponent: () => import('./features/accounts/accounts-page').then((m) => m.AccountsPage),
      },
      {
        // detalhe de um run (drill-down) — rota própria, ANTES da casca de abas
        // (mais específica); fica fora do chrome de abas.
        path: 'accounts/:id/runs/:runId',
        title: 'Análise',
        loadComponent: () =>
          import('./features/run-detail/run-detail-page').then((m) => m.RunDetailPage),
      },
      {
        // casca da conta (6a): cabeçalho + router-tabs; filhos = as abas.
        path: 'accounts/:id',
        title: 'Conta',
        loadComponent: () =>
          import('./features/account-detail/account-shell').then((m) => m.AccountShell),
        children: [
          {
            path: '',
            pathMatch: 'full',
            loadComponent: () =>
              import('./features/account-detail/account-overview').then((m) => m.AccountOverview),
          },
          {
            path: 'agente',
            title: 'Configurar agente',
            loadComponent: () =>
              import('./features/agent-config/agent-config-page').then((m) => m.AgentConfigPage),
          },
          {
            path: 'aprendizados',
            title: 'Aprendizados',
            loadComponent: () =>
              import('./features/agent-config/agent-learnings').then((m) => m.AgentLearnings),
          },
          {
            path: 'criativos',
            title: 'Criativos',
            loadComponent: () =>
              import('./features/account-detail/creative-library').then((m) => m.CreativeLibrary),
          },
          {
            path: 'timeline',
            title: 'Linha do tempo',
            loadComponent: () =>
              import('./features/account-detail/account-timeline').then((m) => m.AccountTimeline),
          },
        ],
      },
      {
        path: 'approvals',
        title: 'Aprovações',
        loadComponent: () =>
          import('./features/approvals/approvals-page').then((m) => m.ApprovalsPage),
      },
      {
        path: 'integrations',
        title: 'Integrações',
        loadComponent: () =>
          import('./features/integrations/integrations-page').then((m) => m.IntegrationsPage),
      },
      // WhatsApp deixou de ser aba (virou integração em Integrações — docs/DESIGN.md).
      // Redirect preserva links antigos.
      { path: 'whatsapp', pathMatch: 'full', redirectTo: 'integrations' },
      {
        path: 'custos',
        title: 'Custos',
        canActivate: [ownerGuard],
        loadComponent: () => import('./features/costs/costs-page').then((m) => m.CostsPage),
      },
      {
        path: 'settings',
        title: 'Configurações',
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
        title: 'Entrar',
        data: { mode: 'login' },
        loadComponent: () => import('./features/login/login-page').then((m) => m.LoginPage),
      },
      {
        path: 'signup',
        title: 'Criar conta',
        data: { mode: 'signup' },
        loadComponent: () => import('./features/login/login-page').then((m) => m.LoginPage),
      },
      {
        path: 'verify-email',
        title: 'Confirmar email',
        loadComponent: () =>
          import('./features/verify-email/verify-email-page').then((m) => m.VerifyEmailPage),
      },
      {
        path: 'forgot-password',
        title: 'Redefinir senha',
        loadComponent: () =>
          import('./features/forgot-password/forgot-password-page').then((m) => m.ForgotPasswordPage),
      },
      {
        path: 'reset-password',
        title: 'Nova senha',
        loadComponent: () =>
          import('./features/reset-password/reset-password-page').then((m) => m.ResetPasswordPage),
      },
    ],
  },
  {
    // Muro do gate de beta (6b): logado + verificado, mas acesso ainda não liberado.
    // Fora do shell (senão activeAccessGuard entraria em loop) e fora do guestOnly.
    path: 'acesso-pendente',
    title: 'Acesso em análise',
    canActivate: [authGuard, pendingAccessGuard],
    loadComponent: () =>
      import('./features/pending-access/pending-access-page').then((m) => m.PendingAccessPage),
  },
  { path: '**', redirectTo: '' },
];
