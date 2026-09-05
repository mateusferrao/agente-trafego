import { ChangeDetectionStrategy, Component, type OnInit, inject, input, signal } from '@angular/core';
import { toast } from 'ngx-sonner';
import { UiButton, UiCallout, UiConfirmDialogService, UiEyebrow } from '@ui';
import { AnalysisApiService } from '@core/api/analysis-api.service';
import { ApprovalsApiService } from '@core/api/approvals-api.service';
import { ApprovalApplyStateService } from '@app/features/approvals/approval-apply-state.service';
import type { LastRunActionsOutput } from '@core/api/generated';
import { UNDO_WARNING, actionTypeLabel, deadlineText, entityTargetLabel } from '@app/shared/action-format';

type Applied = LastRunActionsOutput['applied'][number];
type Suggested = LastRunActionsOutput['suggested'][number];
type Dropped = LastRunActionsOutput['dropped'][number];

/** Poll do desfecho do revert (o worker reverte async) — "Revertendo…" → revertido/bloqueado/timeout. */
const REVERT_POLL_MS = 1500;
const REVERT_POLL_TIMEOUT_MS = 30_000;

/**
 * Mini-surface (5a/5b): ações que o agente APLICOU (com reverter, dentro do TTL —
 * cross-run) + as que SUGERIU e precisam do seu OK (cross-run) desta conta.
 * Self-contained (carrega o próprio dado, silencioso). O histórico completo é a
 * Timeline (6a).
 */
@Component({
  selector: 'app-agent-actions',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [UiButton, UiEyebrow, UiCallout],
  template: `
    @if (applied().length > 0 || suggested().length > 0 || dropped().length > 0) {
      <section class="flex flex-col gap-4 rounded-lg border border-line bg-panel p-5">
        @if (applied().length > 0) {
          <div class="flex flex-col gap-2">
            <h2 class="font-brand text-sm font-semibold text-ink">O que o agente fez</h2>
            <ul class="flex flex-col gap-2">
              @for (a of applied(); track a.toolCallId) {
                <li class="flex flex-col gap-2 rounded-md border border-line bg-soft px-3 py-2 sm:flex-row sm:items-start sm:justify-between sm:gap-3">
                  <span class="flex min-w-0 flex-col gap-0.5">
                    <span class="flex flex-wrap items-center gap-2 text-sm text-ink">
                      <span class="font-medium">{{ typeLabel(a.type) }}</span>
                      <span class="text-muted">{{ targetOf(a) }}</span>
                      @if (a.simulated) {
                        <app-ui-eyebrow>simulado</app-ui-eyebrow>
                      } @else if (a.reverted) {
                        <app-ui-eyebrow>revertido</app-ui-eyebrow>
                      }
                      @if (a.fromPreviousRun) {
                        <app-ui-eyebrow>análise anterior</app-ui-eyebrow>
                      }
                    </span>
                    @if (a.revertBlocked && a.revertBlockedReason) {
                      <span class="text-xs text-muted">Não revertida: {{ a.revertBlockedReason }}</span>
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
                <li class="flex flex-col gap-2 rounded-md border border-line bg-soft px-3 py-2 sm:flex-row sm:items-start sm:justify-between sm:gap-3">
                  <span class="flex min-w-0 flex-col gap-0.5">
                    <span class="flex flex-wrap items-center gap-2 text-sm text-ink">
                      <span class="font-medium">{{ typeLabel(s.type) }}</span>
                      <span>{{ targetOf(s) }}</span>
                      @if (s.fromPreviousRun) {
                        <app-ui-eyebrow>análise anterior</app-ui-eyebrow>
                      }
                    </span>
                    <span class="text-xs text-muted">{{ s.reason }}</span>
                    @for (r of s.ressalvas ?? []; track r.code) {
                      <app-ui-callout tone="warning">{{ r.message }}</app-ui-callout>
                    }
                    @if (s.applyPreview.message; as m) {
                      <app-ui-callout [tone]="s.applyPreview.effect === 'blocked' ? 'blocked' : 'warning'">{{ m }}</app-ui-callout>
                    }
                    @if (deadline(s.expiresAt); as d) {
                      <app-ui-eyebrow>{{ d }}</app-ui-eyebrow>
                    }
                    @if (applyState.label(s.approvalId); as lbl) {
                      <span class="text-xs text-ink">{{ lbl }}</span>
                    }
                  </span>
                  @if (!applyState.isResolvedNonFailed(s.approvalId)) {
                    <span class="flex gap-2 sm:shrink-0">
                      <button appButton variant="secondary" size="sm" class="flex-1 sm:flex-none" [disabled]="busy(s.approvalId)" (click)="reject(s)">
                        Rejeitar
                      </button>
                      <button appButton size="sm" class="flex-1 sm:flex-none" [disabled]="busy(s.approvalId) || s.applyPreview.effect === 'blocked'" (click)="approve(s)">
                        {{ applyState.stateOf(s.approvalId) === 'applying' ? 'Enviando…' : 'Aprovar' }}
                      </button>
                    </span>
                  }
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
                    <app-ui-eyebrow>barrada</app-ui-eyebrow>
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
  /** Estado "Aplicando… → desfecho" — mesma peça compartilhada das outras superfícies. */
  protected readonly applyState = inject(ApprovalApplyStateService);
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
    // o undo é ASYNC (fila) → não marca otimista (pode ser barrado por drift). Enfileira e faz POLL
    // do desfecho real (igual ao polling da aprovação): revertido / bloqueado / ainda processando.
    this.api.undoAction(this.accountId(), a.toolCallId, force).subscribe({
      next: () => this.pollRevert(a.toolCallId, Date.now()),
      error: () => {
        this.clearReverting(a.toolCallId);
        toast.error('Não consegui reverter agora. Tente de novo em instantes.');
      },
    });
  }

  /** Acompanha o desfecho do revert relendo o last-run: `reverted` = sucesso; `revertBlocked` =
   *  drift ("reverter mesmo assim"); nada mudou no prazo = ainda processando. */
  private pollRevert(toolCallId: string, startedAt: number): void {
    if (Date.now() - startedAt > REVERT_POLL_TIMEOUT_MS) {
      this.clearReverting(toolCallId);
      toast.info('Ainda revertendo — atualize em instantes pra ver o resultado.');
      return;
    }
    this.api.lastRunActions(this.accountId()).subscribe({
      next: (r) => {
        const fresh = r.applied.find((x) => x.toolCallId === toolCallId);
        if (fresh?.reverted) {
          this.updateApplied(fresh);
          this.clearReverting(toolCallId);
          toast.success('Ação revertida — voltou ao estado anterior.');
          return;
        }
        if (fresh?.revertBlocked) {
          this.updateApplied(fresh);
          this.clearReverting(toolCallId);
          toast.error(fresh.revertBlockedReason ? `Não reverti: ${fresh.revertBlockedReason}` : 'Não consegui reverter — a entidade mudou desde então.');
          return;
        }
        setTimeout(() => this.pollRevert(toolCallId, startedAt), REVERT_POLL_MS);
      },
      error: () => setTimeout(() => this.pollRevert(toolCallId, startedAt), REVERT_POLL_MS),
    });
  }

  /** Substitui um item aplicado pelo estado fresco (reverted/revertBlocked). */
  private updateApplied(fresh: Applied): void {
    this.applied.update((list) => list.map((x) => (x.toolCallId === fresh.toolCallId ? fresh : x)));
  }

  private clearReverting(id: string): void {
    this.reverting.update((s) => {
      const next = new Set(s);
      next.delete(id);
      return next;
    });
  }

  /** Aprovar: o serviço compartilhado enfileira + acompanha "Aplicando… → desfecho real". */
  protected approve(s: Suggested): void {
    this.applyState.approve(s.approvalId, () => toast.error('Não consegui concluir agora — atualize a página pra ver o estado atual.'));
  }

  /** Ocupado (aplicando OU resolvendo) → desabilita os botões. */
  protected busy(id: string): boolean {
    return this.resolving().has(id) || this.applyState.stateOf(id) === 'applying';
  }

  /** Rejeitar: descarta a sugestão (nada é aplicado na Meta). */
  protected reject(s: Suggested): void {
    this.markResolving(s.approvalId);
    this.approvalsApi.resolve(s.approvalId, 'reject').subscribe({
      next: () => {
        this.removeSuggested(s.approvalId);
        toast.success('Descartei a sugestão.');
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
