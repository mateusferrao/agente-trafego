import { ChangeDetectionStrategy, Component } from '@angular/core';

// Contas Meta = lista das ad accounts conectadas (CLAUDE.md §6 ad_accounts).
// Cada linha: nome/id da conta, status do token (valid|invalid — code 190 → recolar),
// agente vinculado (1:1 no MVP) e última validação. Ação primária: conectar nova conta.
//
// TODO(vendoring): usar <ui-page-header>, <ui-record-list>/<ui-record-row> e
// <ui-badge> (status do token) de shared/ui — ver VENDORING.md.
@Component({
  selector: 'app-accounts-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="flex flex-col gap-6">
      <header class="flex items-start justify-between gap-4">
        <div class="flex flex-col gap-1">
          <h1 class="font-brand text-2xl font-semibold text-ink">Contas Meta</h1>
          <p class="text-sm text-muted">Contas de anúncio conectadas via System User token.</p>
        </div>
        <button class="rounded-md bg-accent px-4 py-2 text-sm font-semibold text-panel hover:bg-accent-strong">
          Conectar conta
        </button>
      </header>

      <!-- Placeholder de lista. Empty state real quando não houver contas conectadas. -->
      <div class="rounded-lg border border-line bg-panel p-6 text-sm text-muted">
        Stub da lista de contas Meta — status do token, agente vinculado e última validação por linha.
      </div>
    </div>
  `,
})
export class AccountsPage {}
