// Árvore de navegação tipada — fonte única da estrutura do app shell.
// Mantém a nav desacoplada das rotas (as rotas apontam para componentes; aqui
// descrevemos o que aparece na sidebar e em que ordem). Ver DESIGN.md §5.

export interface AppModule {
  /** Identificador estável (analytics / active-state). */
  readonly id: string;
  /** Rótulo curto exibido na sidebar (14px medium — DESIGN.md §3 Label). */
  readonly label: string;
  /** Rota absoluta (routerLink). */
  readonly route: string;
  /** Nome do ícone (chave do set de ícones vendorizado do design system). */
  readonly icon: string;
  /** Descrição curta para tooltip / empty states. */
  readonly description: string;
}

export interface AppModuleGroup {
  readonly id: string;
  readonly label: string;
  readonly modules: readonly AppModule[];
}

// Grupos da navegação principal. A ordem reflete o fluxo operacional diário:
// primeiro o que aconteceu (timeline), depois os objetos que o usuário configura.
export const APP_MODULE_GROUPS: readonly AppModuleGroup[] = [
  {
    id: 'operate',
    label: 'Operar',
    modules: [
      {
        id: 'timeline',
        label: 'Timeline',
        route: '/timeline',
        icon: 'activity',
        description: 'Análises, recomendações e ações aplicadas por conta.',
      },
    ],
  },
  {
    id: 'configure',
    label: 'Configurar',
    modules: [
      {
        id: 'agents',
        label: 'Agentes',
        route: '/agents',
        icon: 'bot',
        description: 'Superfície única de config do agente, semeada por arquétipo.',
      },
      {
        id: 'accounts',
        label: 'Contas Meta',
        route: '/accounts',
        icon: 'meta',
        description: 'Contas de anúncio conectadas via System User token.',
      },
    ],
  },
  {
    id: 'system',
    label: 'Sistema',
    modules: [
      {
        id: 'settings',
        label: 'Configurações',
        route: '/settings',
        icon: 'settings',
        description: 'Organização, canal WhatsApp, membros e preferências.',
      },
    ],
  },
] as const;

/** Lista achatada — útil para resolver o item ativo a partir da URL. */
export const APP_MODULES: readonly AppModule[] = APP_MODULE_GROUPS.flatMap((g) => g.modules);
