import { ChangeDetectionStrategy, Component, type OnInit, inject, input, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { toast } from 'ngx-sonner';
import { UiBadge, UiButton, UiConfirmDialogService, UiEmptyState, UiSpinner } from '@ui';
import { AnalysisApiService } from '@core/api/analysis-api.service';
import { LearningsApiService } from '@core/api/learnings-api.service';
import { AGENT_NAME } from '@core/brand';
import type { LearningsList } from '@core/api/generated';

type Learning = LearningsList['items'][number];

/** Selo de confiança → tom+texto (nunca só cor — §UX). */
const TIER_TONE: Record<Learning['tier'], 'neutral' | 'info' | 'success'> = {
  explorando: 'neutral',
  provavel: 'info',
  confirmado: 'success',
};
const TIER_LABEL: Record<Learning['tier'], string> = {
  explorando: 'Explorando',
  provavel: 'Provável',
  confirmado: 'Confirmado',
};
/** Origem em linguagem de gente (traduz o enum técnico). */
const ORIGIN_LABEL: Record<Learning['origin'], string> = {
  our_action: 'a partir de uma ação aplicada',
  observational: 'observando sua conta',
  human_feedback: 'do seu feedback',
  human_manual: 'de uma mudança que você fez',
};

/**
 * Aba "Aprendizados" (S1, read-only): o que o agente aprendeu observando esta conta.
 * Pull, não empurra. Cada lição mostra a frase, o selo de confiança (tom+texto) e a
 * origem. Editar/confirmar/esquecer entram na S5.
 */
@Component({
  selector: 'app-agent-learnings',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [UiBadge, UiButton, UiEmptyState, UiSpinner],
  template: `
    <section class="flex flex-col gap-4 rounded-lg border border-line bg-panel p-5">
      <div>
        <h2 class="font-brand text-base font-semibold text-ink">O que o agente aprendeu</h2>
        <p class="mt-1 text-xs text-muted">
          Padrões que {{ agentName }} vem notando nesta conta ao longo das análises. Os
          <span class="text-ink">confirmados</span> já pesam no diagnóstico; os que ainda estão
          <span class="text-ink">em teste</span> ele acompanha com cautela até se confirmarem.
        </p>
      </div>

      @if (loading()) {
        <div class="flex items-center gap-2 text-sm text-muted"><app-ui-spinner /> Carregando aprendizados…</div>
      } @else if (failed()) {
        <p class="text-sm text-muted">
          Não consegui carregar os aprendizados agora.
          <button type="button" class="text-accent-strong underline" (click)="reload()">Tentar de novo</button>
        </p>
      } @else if (items().length === 0) {
        <app-ui-empty-state
          brand
          title="Ainda estou conhecendo esta conta"
          [description]="'Conforme ' + agentName + ' acompanha os resultados, os padrões que ele perceber aparecem aqui. Não precisa fazer nada — é automático.'"
        />
      } @else {
        <ul class="flex flex-col gap-3">
          @for (l of items(); track l.id) {
            <li class="flex flex-col gap-2 rounded-md border border-line/60 bg-soft/40 p-4">
              @if (editingId() === l.id) {
                <textarea
                  class="w-full rounded-md border border-line bg-panel p-2 text-sm text-ink"
                  rows="2"
                  [value]="editText()"
                  (input)="editText.set($any($event.target).value)"
                ></textarea>
                <div class="flex gap-2">
                  <button type="button" appButton size="sm" variant="primary" [disabled]="busy()" (click)="saveEdit(l)">Salvar</button>
                  <button type="button" appButton size="sm" variant="ghost" [disabled]="busy()" (click)="cancelEdit()">Cancelar</button>
                </div>
              } @else {
                <p class="text-sm text-ink">{{ l.content }}</p>
                <div class="flex flex-wrap items-center gap-2 text-[11px] text-muted">
                  <span appBadge [tone]="tierTone(l)" size="xs">{{ tierLabel(l) }}</span>
                  <span>{{ originLabel(l) }}</span>
                  @if (l.reinforceCount > 0) {
                    <span>· visto {{ l.reinforceCount + 1 }}×</span>
                  }
                  @if (l.lifecycle === 'stale') {
                    <span appBadge tone="neutral" size="xs">desbotando</span>
                  }
                </div>
                <div class="flex flex-wrap gap-2 pt-1">
                  @if (!l.confirmedByHuman) {
                    <button type="button" appButton size="sm" variant="secondary" [disabled]="busy()" (click)="confirm(l)">É isso mesmo</button>
                  }
                  <button type="button" appButton size="sm" variant="ghost" [disabled]="busy()" (click)="startEdit(l)">Editar</button>
                  <button type="button" appButton size="sm" variant="ghost" [disabled]="busy()" (click)="forget(l)">Esquecer</button>
                </div>
              }
            </li>
          }
        </ul>
      }
    </section>
  `,
})
export class AgentLearnings implements OnInit {
  private readonly analysisApi = inject(AnalysisApiService);
  private readonly learningsApi = inject(LearningsApiService);
  private readonly confirmDialog = inject(UiConfirmDialogService);

  readonly accountId = input.required<string>();

  protected readonly agentName = AGENT_NAME;
  protected readonly loading = signal(true);
  protected readonly failed = signal(false);
  protected readonly busy = signal(false);
  // a API já exclui arquivados (fonte única da regra) — aqui é só o que ela devolve.
  protected readonly items = signal<Learning[]>([]);
  private readonly agentId = signal<string | null>(null);
  protected readonly editingId = signal<string | null>(null);
  protected readonly editText = signal('');

  ngOnInit(): void {
    this.reload();
  }

  protected reload(): void {
    this.loading.set(true);
    this.failed.set(false);
    // resolve o agente da conta (silencioso — a página-mãe já busca), depois as lições.
    this.analysisApi.getAgent(this.accountId(), { silent: true }).subscribe({
      next: (agent) => {
        this.agentId.set(agent.agentId);
        this.loadLessons(agent.agentId);
      },
      error: () => this.fail(),
    });
  }

  private loadLessons(agentId: string): void {
    this.learningsApi.list(agentId, { silent: true }).subscribe({
      next: (out) => {
        this.items.set(out.items);
        this.loading.set(false);
      },
      error: () => this.fail(),
    });
  }

  private fail(): void {
    this.failed.set(true);
    this.loading.set(false);
  }

  protected async confirm(l: Learning): Promise<void> {
    const id = this.agentId();
    if (!id || this.busy()) return;
    this.busy.set(true);
    try {
      await firstValueFrom(this.learningsApi.confirm(id, l.id));
      toast.success('aprendizado confirmado');
      this.loadLessons(id);
    } finally {
      this.busy.set(false);
    }
  }

  protected async forget(l: Learning): Promise<void> {
    const id = this.agentId();
    if (!id || this.busy()) return;
    const ok = await this.confirmDialog.confirm({
      title: 'Esquecer este aprendizado?',
      description: 'O agente para de considerar isso. Ele pode reaprender no futuro se o padrão voltar.',
      confirmLabel: 'Esquecer',
      cancelLabel: 'Manter',
      tone: 'danger',
    });
    if (!ok) return;
    this.busy.set(true);
    try {
      await firstValueFrom(this.learningsApi.forget(id, l.id));
      toast.success('aprendizado esquecido');
      this.loadLessons(id);
    } finally {
      this.busy.set(false);
    }
  }

  protected startEdit(l: Learning): void {
    this.editingId.set(l.id);
    this.editText.set(l.content);
  }
  protected cancelEdit(): void {
    this.editingId.set(null);
  }
  protected async saveEdit(l: Learning): Promise<void> {
    const id = this.agentId();
    const content = this.editText().trim();
    if (!id || this.busy() || content.length === 0) return;
    this.busy.set(true);
    try {
      await firstValueFrom(this.learningsApi.edit(id, l.id, { content }));
      this.editingId.set(null);
      toast.success('aprendizado atualizado');
      this.loadLessons(id);
    } finally {
      this.busy.set(false);
    }
  }

  protected tierTone(l: Learning): 'neutral' | 'info' | 'success' {
    return TIER_TONE[l.tier];
  }
  protected tierLabel(l: Learning): string {
    return TIER_LABEL[l.tier];
  }
  protected originLabel(l: Learning): string {
    return ORIGIN_LABEL[l.origin];
  }
}
