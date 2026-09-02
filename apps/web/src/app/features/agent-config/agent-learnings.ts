import { ChangeDetectionStrategy, Component, type OnInit, computed, inject, input, signal } from '@angular/core';
import { UiBadge, UiEmptyState, UiSpinner } from '@ui';
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
  imports: [UiBadge, UiEmptyState, UiSpinner],
  template: `
    <section class="flex flex-col gap-4 rounded-lg border border-line bg-panel p-5">
      <div>
        <h2 class="font-brand text-base font-semibold text-ink">O que o agente aprendeu</h2>
        <p class="mt-1 text-xs text-muted">
          Padrões que {{ agentName }} vem notando nesta conta ao longo das análises. Ele considera isso no diagnóstico —
          e confia no dado atual se ele contradisser.
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

  readonly accountId = input.required<string>();

  protected readonly agentName = AGENT_NAME;
  protected readonly loading = signal(true);
  protected readonly failed = signal(false);
  private readonly all = signal<Learning[]>([]);
  // não mostra arquivados (esquecidos) — só o que ainda vale.
  protected readonly items = computed(() => this.all().filter((l) => l.lifecycle !== 'archived'));

  ngOnInit(): void {
    this.reload();
  }

  protected reload(): void {
    this.loading.set(true);
    this.failed.set(false);
    // resolve o agente da conta (silencioso — a página-mãe já busca), depois as lições.
    this.analysisApi.getAgent(this.accountId(), { silent: true }).subscribe({
      next: (agent) => this.loadLessons(agent.agentId),
      error: () => this.fail(),
    });
  }

  private loadLessons(agentId: string): void {
    this.learningsApi.list(agentId, { silent: true }).subscribe({
      next: (out) => {
        this.all.set(out.items);
        this.loading.set(false);
      },
      error: () => this.fail(),
    });
  }

  private fail(): void {
    this.failed.set(true);
    this.loading.set(false);
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
