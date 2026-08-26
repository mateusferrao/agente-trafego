// Árvore de navegação tipada — fonte única da estrutura do app shell.
// Mantém a nav desacoplada das rotas (as rotas apontam para componentes; aqui
// descrevemos o que aparece na sidebar e em que ordem). Ver docs/DESIGN.md (IA).
//
// IA da Fatia 1a: Contas (landing, '/accounts'), Aprovações, Integrações, Configurações.
// Aprovações e Integrações são placeholders "em breve" nesta fatia.

export interface AppModule {
  /** Identificador estável (active-state / testes). */
  readonly id: string;
  /** Rótulo curto exibido na sidebar (14px medium — DESIGN.md §3 Label). */
  readonly label: string;
  /** Rota absoluta (routerLink). */
  readonly route: string;
  /** Nome do ícone (chave do set @ng-icons/lucide registrado no shell). */
  readonly icon: string;
  /** Casamento exato de rota ativa (necessário para a raiz '/'). */
  readonly exact: boolean;
  /** Descrição curta para tooltip / empty states. */
  readonly description: string;
  /** Só aparece para o owner da org (ex: custos/COGS). Default: todos. */
  readonly ownerOnly?: boolean;
}

export interface AppModuleGroup {
  readonly id: string;
  readonly label: string;
  readonly modules: readonly AppModule[];
}

export const APP_MODULE_GROUPS: readonly AppModuleGroup[] = [
  {
    id: 'operate',
    label: 'Operar',
    modules: [
      {
        id: 'dashboard',
        label: 'Painel',
        route: '/dashboard',
        icon: 'lucideHouse',
        exact: true,
        description: 'Visão gerencial: onde agir agora, em todas as contas.',
      },
      {
        id: 'accounts',
        label: 'Contas',
        route: '/accounts',
        icon: 'lucideLayoutGrid',
        exact: false,
        description: 'Contas de anúncio conectadas e seus agentes.',
      },
      {
        id: 'approvals',
        label: 'Aprovações',
        route: '/approvals',
        icon: 'lucideCircleCheck',
        exact: false,
        description: 'Ações que aguardam seu OK antes de aplicar.',
      },
    ],
  },
  {
    id: 'configure',
    label: 'Configurar',
    modules: [
      {
        id: 'integrations',
        label: 'Integrações',
        route: '/integrations',
        icon: 'lucideLayoutDashboard',
        exact: false,
        description: 'Conecte a Meta e o WhatsApp e escolha quais contas gerir.',
      },
      {
        id: 'costs',
        label: 'Custos',
        route: '/custos',
        icon: 'lucideBanknote',
        exact: false,
        description: 'Custo operacional (COGS) por conta e período.',
        ownerOnly: true,
      },
      {
        id: 'settings',
        label: 'Configurações',
        route: '/settings',
        icon: 'lucideSettings',
        exact: false,
        description: 'Perfil, organização, tema e acesso.',
      },
    ],
  },
] as const;

/** Lista achatada — útil para resolver o item ativo a partir da URL. */
export const APP_MODULES: readonly AppModule[] = APP_MODULE_GROUPS.flatMap((g) => g.modules);
