import { ChangeDetectionStrategy, Component } from '@angular/core';

// Configurações = ajustes da org (tenant). Escopo MVP: dados da organização,
// canal WhatsApp (instância Evolution, status da conexão), membros/roles
// (owner|member, org-wide — CLAUDE.md §12) e preferências gerais.
// Billing/entitlements ficam para fast-follow (CLAUDE.md §11).
//
// TODO(vendoring): <ui-page-header>, <ui-tabs> (seções), <ui-form-field>,
// <ui-switch>, <ui-badge> (status do canal).
@Component({
  selector: 'app-settings-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="flex max-w-3xl flex-col gap-6">
      <header class="flex flex-col gap-1">
        <h1 class="font-brand text-2xl font-semibold text-ink">Configurações</h1>
        <p class="text-sm text-muted">Organização, canal WhatsApp, membros e preferências.</p>
      </header>

      <div class="rounded-lg border border-line bg-panel p-6 text-sm text-muted">
        Stub de configurações — dados da org, conexão WhatsApp (Evolution) e membros/roles.
      </div>
    </div>
  `,
})
export class SettingsPage {}
