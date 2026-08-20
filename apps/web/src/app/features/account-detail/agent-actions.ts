import { ChangeDetectionStrategy, Component, type OnInit, inject, input, signal } from '@angular/core';
import { toast } from 'ngx-sonner';
import { UiBadge, UiButton } from '@ui';
import { AnalysisApiService } from '@core/api/analysis-api.service';
import type { LastRunActionsOutput } from '@core/api/generated';

type Applied = LastRunActionsOutput['applied'][number];
type Suggested = LastRunActionsOutput['suggested'][number];

/** Rótulo legível de um tipo de ação (o toolKey vem cru do backend). */
const TYPE_LABEL: Record<string, string> = {
  pause_entity: 'Pausar',
  resume_entity: 'Retomar',
  adjust_budget: 'Ajustar orçamento',
  set_status: 'Mudar status',
};
const LEVEL_LABEL: Record<string, string> = { campaign: 'campanha', adset: 'conjunto', ad: 'anúncio' };

function label(type: string): string {
  return TYPE_LABEL[type] ?? type;
}
function target(a: { targetLevel: string; targetId: string }): string {
  return `${LEVEL_LABEL[a.targetLevel] ?? a.targetLevel} ${a.targetId}`;
}

const UNDO_WARNING =
  'Reverter volta a entidade ao estado de antes desta ação. Se ela mudou desde então, isso sobrescreve a mudança. Continuar?';

/**
 * Mini-surface (5a): ações que o agente APLICOU (com reverter) + as que SUGERIU e
 * precisam do seu OK, no último run desta conta. Self-contained (carrega o próprio
 * dado, silencioso). O histórico completo é a Timeline (6a).
 */
@Component({
  selector: 'app-agent-actions',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [UiBadge, UiButton],
  template: `
    @if (applied().length > 0 || suggested().length > 0) {
      <section class="flex flex-col gap-4 rounded-lg border border-line bg-panel p-5">
        @if (applied().length > 0) {
          <div class="flex flex-col gap-2">
            <h2 class="font-brand text-sm font-semibold text-ink">O que o agente fez neste run</h2>
            <ul class="flex flex-col gap-2">
              @for (a of applied(); track a.toolCallId) {
                <li class="flex items-center justify-between gap-3 rounded-md border border-line bg-soft px-3 py-2">
                  <span class="flex flex-wrap items-center gap-2 text-sm text-ink">
                    <span class="font-medium">{{ typeLabel(a.type) }}</span>
                    <span class="text-muted">{{ targetOf(a) }}</span>
                    @if (a.simulated) {
                      <span appBadge tone="neutral">simulado (dry-run)</span>
                    } @else if (a.reverted) {
                      <span appBadge tone="neutral">revertido</span>
                    }
                  </span>
                  @if (!a.simulated && !a.reverted) {
                    <button appButton variant="secondary" size="sm" [disabled]="reverting().has(a.toolCallId)" (click)="revert(a)">
                      {{ reverting().has(a.toolCallId) ? 'Revertendo…' : 'Reverter' }}
                    </button>
                  }
                </li>
              }
            </ul>
          </div>
        }

        @if (suggested().length > 0) {
          <div class="flex flex-col gap-2">
            <h2 class="font-brand text-sm font-semibold text-ink">Sugeridas — precisam do seu OK</h2>
            <ul class="flex flex-col gap-2">
              @for (s of suggested(); track $index) {
                <li class="flex flex-col gap-0.5 rounded-md border border-line bg-soft px-3 py-2">
                  <span class="text-sm text-ink"><span class="font-medium">{{ typeLabel(s.type) }}</span> {{ targetOf(s) }}</span>
                  <span class="text-xs text-muted">{{ s.reason }}</span>
                </li>
              }
            </ul>
          </div>
        }
      </section>
    }
  `,
})
export class AgentActions implements OnInit {
  private readonly api = inject(AnalysisApiService);

  readonly accountId = input.required<string>();

  protected readonly applied = signal<readonly Applied[]>([]);
  protected readonly suggested = signal<readonly Suggested[]>([]);
  protected readonly reverting = signal<ReadonlySet<string>>(new Set());

  protected typeLabel = label;
  protected targetOf = target;

  ngOnInit(): void {
    this.load();
  }

  private load(): void {
    this.api.lastRunActions(this.accountId()).subscribe({
      next: (r) => {
        this.applied.set(r.applied);
        this.suggested.set(r.suggested);
      },
      error: () => {},
    });
  }

  protected revert(a: Applied): void {
    if (!confirm(UNDO_WARNING)) return;
    this.reverting.update((s) => new Set(s).add(a.toolCallId));
    this.api.undoAction(this.accountId(), a.toolCallId).subscribe({
      next: () => {
        // undo é assíncrono (fila) — marca revertido otimista + avisa.
        this.applied.update((list) => list.map((x) => (x.toolCallId === a.toolCallId ? { ...x, reverted: true } : x)));
        this.clearReverting(a.toolCallId);
        toast.success('revertendo — a ação volta ao estado anterior');
      },
      error: () => this.clearReverting(a.toolCallId),
    });
  }

  private clearReverting(id: string): void {
    this.reverting.update((s) => {
      const next = new Set(s);
      next.delete(id);
      return next;
    });
  }
}
