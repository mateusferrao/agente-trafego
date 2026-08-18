import { ChangeDetectionStrategy, Component } from '@angular/core';

// Timeline = superfície operacional principal (CLAUDE.md §15, milestone 6).
// Fluxo cronológico por conta de: runs do agente (análises), recomendações
// (com feedback/outcome) e ações aplicadas (pause/budget/status) com trilha de
// auditoria. Aprovações pendentes (HITL) aparecem aqui e no WhatsApp.
// Referência Attio: timeline compacta, contexto do objeto, estado explícito
// (DESIGN.md §5 Workflow Surfaces).
//
// TODO(vendoring): <ui-page-header>, <ui-record-list>, <ui-badge> (riskLevel/source),
// <ui-empty-state> (conta sem runs ainda), <ui-pulse-dot> (run em andamento).
@Component({
  selector: 'app-timeline-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="flex flex-col gap-6">
      <header class="flex flex-col gap-1">
        <h1 class="font-brand text-2xl font-semibold text-ink">Timeline</h1>
        <p class="text-sm text-muted">
          Análises, recomendações e ações aplicadas — em ordem, por conta, com trilha de auditoria.
        </p>
      </header>

      <!-- Placeholder do feed cronológico. Cada item: tipo (run|recomendação|ação),
           origem (playbook|llm), riskLevel e status (proposto|aprovado|aplicado). -->
      <div class="rounded-lg border border-line bg-panel p-6 text-sm text-muted">
        Stub da timeline — runs do agente, recomendações com feedback/outcome e ações aplicadas.
      </div>
    </div>
  `,
})
export class TimelinePage {}
