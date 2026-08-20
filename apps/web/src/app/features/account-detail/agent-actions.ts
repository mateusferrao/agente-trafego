import { ChangeDetectionStrategy, Component, type OnInit, inject, input, signal } from '@angular/core';
import { toast } from 'ngx-sonner';
import { UiBadge, UiButton, UiConfirmDialogService } from '@ui';
import { AnalysisApiService } from '@core/api/analysis-api.service';
import { ApprovalsApiService } from '@core/api/approvals-api.service';
import type { LastRunActionsOutput } from '@core/api/generated';
import { UNDO_WARNING, actionTypeLabel, deadlineText, entityTargetLabel } from '@app/shared/action-format';

type Applied = LastRunActionsOutput['applied'][number];
type Suggested = LastRunActionsOutput['suggested'][number];
type Dropped = LastRunActionsOutput['dropped'][number];

/**
 * Mini-surface (5a/5b): ações que o agente APLICOU (com reverter, dentro do TTL —
 * cross-run) + as que SUGERIU e precisam do seu OK (cross-run) desta conta.
 * Self-contained (carrega o próprio dado, silencioso). O histórico completo é a
 * Timeline (6a).
 */
@Component({
  selector: 'app-agent-actions',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [UiBadge, UiButton],
  template: `
    @if (applied().length > 0 || suggested().length > 0 || dropped().length > 0) {
      <section class="flex flex-col gap-4 rounded-lg border border-line bg-panel p-5">
        @if (applied().length > 0) {
          <div class="flex flex-col gap-2">
            <h2 class="font-brand text-sm font-semibold text-ink">O que o agente fez</h2>
            <ul class="flex flex-col gap-2">
              @for (a of applied(); track a.toolCallId) {
                <li class="flex items-start justify-between gap-3 rounded-md border border-line bg-soft px-3 py-2">
                  <span class="flex min-w-0 flex-col gap-0.5">
                    <span class="flex flex-wrap items-center gap-2 text-sm text-ink">
                      <span class="font-medium">{{ typeLabel(a.type) }}</span>
                      <span class="text-muted">{{ targetOf(a) }}</span>
                      @if (a.simulated) {
                        <span appBadge tone="neutral">simulado (dry-run)</span>
                      } @else if (a.reverted) {
                        <span appBadge tone="neutral">revertido</span>
                      }
                      @if (a.fromPreviousRun) {
                        <span appBadge tone="neutral" size="xs">de uma análise anterior</span>
                      }
                    </span>
                    @if (a.revertBlocked && a.revertBlockedReason) {
                      <span class="text-xs text-muted">↩️ não revertida — {{ a.revertBlockedReason }}</span>
                    }
                  </span>
                  @if (a.revertBlocked) {
                    <button appButton variant="secondary" size="sm" [disabled]="reverting().has(a.toolCallId)" (click)="revert(a, true)">
                      {{ reverting().has(a.toolCallId) ? 'Revertendo…' : 'Reverter mesmo assim' }}
                    </button>
                  } @else if (a.undoable) {
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
              @for (s of suggested(); track s.approvalId) {
                <li class="flex items-start justify-between gap-3 rounded-md border border-line bg-soft px-3 py-2">
                  <span class="flex min-w-0 flex-col gap-0.5">
                    <span class="flex flex-wrap items-center gap-2 text-sm text-ink">
                      <span class="font-medium">{{ typeLabel(s.type) }}</span>
                      <span>{{ targetOf(s) }}</span>
                      @if (s.fromPreviousRun) {
                        <span appBadge tone="neutral" size="xs">de uma análise anterior</span>
                      }
                    </span>
                    <span class="text-xs text-muted">{{ s.reason }}</span>
                    @if (deadline(s.expiresAt); as d) {
                      <span class="text-xs text-muted">⏳ {{ d }}</span>
                    }
                  </span>
                  <span class="flex shrink-0 gap-2">
                    <button appButton variant="secondary" size="sm" [disabled]="resolving().has(s.approvalId)" (click)="reject(s)">
                      Rejeitar
                    </button>
                    <button appButton size="sm" [disabled]="resolving().has(s.approvalId)" (click)="approve(s)">
                      {{ resolving().has(s.approvalId) ? 'Enviando…' : 'Aprovar' }}
                    </button>
                  </span>
                </li>
              }
            </ul>
          </div>
        }

        @if (dropped().length > 0) {
          <div class="flex flex-col gap-2">
            <h2 class="font-brand text-sm font-semibold text-ink">Barradas pelos seus limites</h2>
            <ul class="flex flex-col gap-2">
              @for (d of dropped(); track $index) {
                <li class="flex flex-col gap-0.5 rounded-md border border-line bg-soft px-3 py-2">
                  <span class="flex flex-wrap items-center gap-2 text-sm text-ink">
                    <span class="font-medium">{{ typeLabel(d.type) }}</span>
                    <span class="text-muted">{{ targetOf(d) }}</span>
                    <span appBadge tone="neutral">barrada</span>
                  </span>
                  <span class="text-xs text-muted">{{ d.reason }}</span>
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
  private readonly approvalsApi = inject(ApprovalsApiService);
  private readonly confirmDialog = inject(UiConfirmDialogService);

  readonly accountId = input.required<string>();

  protected readonly applied = signal<readonly Applied[]>([]);
  protected readonly suggested = signal<readonly Suggested[]>([]);
  protected readonly dropped = signal<readonly Dropped[]>([]);
  protected readonly reverting = signal<ReadonlySet<string>>(new Set());
  protected readonly resolving = signal<ReadonlySet<string>>(new Set());

  protected typeLabel = actionTypeLabel;
  protected targetOf = (a: { targetLevel: string; targetId: string; targetName?: string | null }): string =>
    entityTargetLabel(a.targetLevel, a.targetId, a.targetName);
  protected deadline = deadlineText;

  ngOnInit(): void {
    this.load();
  }

  private load(): void {
    this.api.lastRunActions(this.accountId()).subscribe({
      next: (r) => {
        this.applied.set(r.applied);
        this.suggested.set(r.suggested);
        this.dropped.set(r.dropped);
      },
      error: () => {},
    });
  }

  protected async revert(a: Applied, force = false): Promise<void> {
    // force = "reverter mesmo assim" após o re-check barrar por drift → avisa o motivo.
    const description = force && a.revertBlockedReason ? `${a.revertBlockedReason}. ${UNDO_WARNING}` : UNDO_WARNING;
    const confirmed = await this.confirmDialog.confirm({
      title: force ? 'Reverter mesmo assim?' : 'Reverter ação?',
      description,
      confirmLabel: 'Reverter',
      tone: 'warning',
    });
    if (!confirmed) return;
    this.reverting.update((s) => new Set(s).add(a.toolCallId));
    this.api.undoAction(this.accountId(), a.toolCallId, force).subscribe({
      next: () => {
        // undo é assíncrono (fila) — marca revertido otimista + avisa. Se o re-check
        // barrar por drift, o próximo carregamento mostra "não revertida" + "mesmo assim".
        this.applied.update((list) =>
          list.map((x) => (x.toolCallId === a.toolCallId ? { ...x, reverted: true, revertBlocked: false } : x)),
        );
        this.clearReverting(a.toolCallId);
        toast.success('Revertendo — a ação volta ao estado anterior');
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

  /** Aprovar: enfileira a aplicação (worker re-checa fresco + aplica). Otimista. */
  protected approve(s: Suggested): void {
    this.markResolving(s.approvalId);
    this.approvalsApi.resolve(s.approvalId, 'approve').subscribe({
      next: () => {
        this.removeSuggested(s.approvalId);
        toast.success('Enviado para aplicação — o agente aplica em instantes');
      },
      error: () => this.clearResolving(s.approvalId),
    });
  }

  /** Rejeitar: descarta a sugestão (nada é aplicado na Meta). */
  protected reject(s: Suggested): void {
    this.markResolving(s.approvalId);
    this.approvalsApi.resolve(s.approvalId, 'reject').subscribe({
      next: () => {
        this.removeSuggested(s.approvalId);
        toast.success('Sugestão descartada');
      },
      error: () => this.clearResolving(s.approvalId),
    });
  }

  private removeSuggested(approvalId: string): void {
    this.suggested.update((list) => list.filter((x) => x.approvalId !== approvalId));
    this.clearResolving(approvalId);
  }

  private markResolving(id: string): void {
    this.resolving.update((s) => new Set(s).add(id));
  }

  private clearResolving(id: string): void {
    this.resolving.update((s) => {
      const next = new Set(s);
      next.delete(id);
      return next;
    });
  }
}
