// Router-tabs (house style Automato) — vendorizado de automato-web `ui-tabs.ts`
// (só as diretivas de ROTA; o tabset in-page/ng-primitives não é usado aqui).
// Uso: <nav appRouteTabs> com <a appRouteTabLink routerLink=... routerLinkActive
// ariaCurrentWhenActive="page"> + um contêiner [appRouteTabPanel] em volta do
// <router-outlet/>. Estado ativo por aria-current (roteador). Só design tokens.

import { Directive } from "@angular/core";

@Directive({
  selector: "nav[appRouteTabs]",
  host: {
    class:
      "flex min-w-0 items-end gap-1 overflow-x-auto border-b border-line pb-1 overscroll-contain",
  },
})
export class UiRouteTabs {}

@Directive({
  selector: "a[appRouteTabLink]",
  host: {
    class:
      "inline-flex min-h-9 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-t-md border-b-2 border-transparent px-3 py-2 text-sm font-semibold text-muted no-underline transition " +
      "hover:bg-soft/60 hover:text-ink aria-[current=page]:border-accent-strong aria-[current=page]:bg-soft/35 aria-[current=page]:text-accent-strong",
  },
})
export class UiRouteTabLink {}

@Directive({
  selector: "[appRouteTabPanel]",
  host: {
    class: "min-w-0 rounded-md border border-line bg-panel p-5 shadow-card",
  },
})
export class UiRouteTabPanel {}
