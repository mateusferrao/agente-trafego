import { ChangeDetectionStrategy, Component, type OnInit, computed, inject, signal } from '@angular/core';
import { toast } from 'ngx-sonner';
import { UiButton, UiConfirmDialogService, UiEmptyState, UiEyebrow, UiPageHeader } from '@ui';
import { AnalysisApiService } from '@core/api/analysis-api.service';
import { ApprovalsApiService } from '@core/api/approvals-api.service';
import { DraftsApiService } from '@core/api/drafts-api.service';
import { AGENT_NAME } from '@core/brand';
import type { ApprovalOutput, DraftApprovalOutput, RevertibleActionOutput } from '@core/api/generated';
import { UNDO_WARNING, actionTypeLabel, deadlineText, entityTargetLabel } from '@app/shared/action-format';
import { conversionLabel } from '@app/shared/conversion-label';
import { money } from '@app/shared/format';

interface AccountGroup<T> {
  readonly accountId: string;
  readonly accountName: string;
  readonly items: readonly T[];
}

/** Agrupa por conta (caixa de entrada legível p/ gestor multi-conta) — genérico:
 *  serve tanto pendentes (ApprovalOutput) quanto revertíveis (RevertibleActionOutput). */
function groupByAccount<T extends { accountId: string; accountName: string }>(
  rows: readonly T[],
): AccountGroup<T>[] {
  const byId = new Map<string, AccountGroup<T> & { items: T[] }>();
  for (const r of rows) {
    const g = byId.get(r.accountId);
    if (g) g.items.push(r);
    else byId.set(r.accountId, { accountId: r.accountId, accountName: r.accountName, items: [r] });
  }
  return [...byId.values()];
}

/**
 * Aprovações = ações que aguardam o OK humano (HITL — CLAUDE.md §7/§8) + ações já
 * aplicadas que ainda podem ser revertidas (dentro do TTL) — cross-conta, duas
 * seções empilhadas. Reverter aqui usa a mesma rota por-conta da mini-surface.
 */
@Component({
  selector: 'app-approvals-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [UiEmptyState, UiPageHeader, UiButton, UiEyebrow],
  template: `
    <div class="flex flex-col gap-8">
      <app-ui-page-header
        title="Aprovações"
        subtitle="Ações que aguardam seu OK ou que ainda podem ser revertidas."
      />

      @if (loaded() && pendingGroups().length === 0 && revertibleGroups().length === 0 && draftGroups().length === 0) {
        <app-ui-empty-state
          brand
          title="Nada aguardando OK nem revertível"
          [description]="emptyDescription"
        />
      } @else {
        @if (draftGroups().length > 0) {
          <section class="flex flex-col gap-4">
            <h1 class="font-brand text-base font-semibold text-ink">Rascunhos de campanha</h1>
            @for (group of draftGroups(); track group.accountId) {
              <div class="flex flex-col gap-3">
                <h2 class="font-brand text-sm font-semibold text-ink">{{ group.accountName }}</h2>
                <ul class="flex flex-col gap-2">
                  @for (d of group.items; track d.id) {
                    <li class="ui-panel-card--brand flex flex-col gap-3">
                      <span class="flex flex-col gap-1">
                        <app-ui-eyebrow>
                          {{ draftKindLabel(d) }}@if (d.origin === 'proactive') { · proposta do {{ agentName }}}@if (deadline(d.expiresAt); as dl) { · {{ dl }}}
                        </app-ui-eyebrow>
                        <span class="font-semibold text-ink">{{ draftTitle(d) }}</span>
                      </span>
                      <dl class="grid grid-cols-1 gap-1 text-sm text-ink sm:grid-cols-2">
                        <div><dt class="inline text-muted">Gasto novo: </dt><dd class="inline font-semibold">{{ money(d.dailyBudgetMajor, d.currency) }}/dia</dd></div>
                        <div><dt class="inline text-muted">Entra: </dt><dd class="inline">{{ d.activation === 'active' ? 'ativa (a Meta revisa antes de veicular)' : 'pausada' }}</dd></div>
                        @if (d.pageId) { <div><dt class="inline text-muted">Página: </dt><dd class="inline">{{ d.pageId }}</dd></div> }
                        @if (d.pixelId) { <div><dt class="inline text-muted">Pixel: </dt><dd class="inline">{{ d.pixelId }}</dd></div> }
                        @if (d.objective) { <div><dt class="inline text-muted">Objetivo: </dt><dd class="inline">{{ objectiveLabel(d.objective) }}</dd></div> }
                        @if (d.sourceLabel) { <div><dt class="inline text-muted">Origem: </dt><dd class="inline">{{ sourceName(d) }}</dd></div> }
                      </dl>
                      @if (d.copyVariants && d.copyVariants.length > 0) {
                        <ul class="flex flex-col gap-2">
                          @for (c of d.copyVariants; track $index) {
                            <li class="rounded-lg border border-line bg-panel px-3 py-2 text-sm">
                              <span class="block font-semibold text-ink">{{ c.headline }}</span>
                              <span class="block text-muted">{{ c.primaryText }}</span>
                            </li>
                          }
                        </ul>
                      }
                      <span class="flex shrink-0 gap-2">
                        <button appButton variant="secondary" size="sm" [disabled]="resolving().has(d.id)" (click)="rejectDraft(d)">
                          Recusar
                        </button>
                        <button appButton size="sm" [disabled]="resolving().has(d.id)" (click)="approveDraft(d)">
                          {{ resolving().has(d.id) ? 'Enviando…' : 'Aprovar' }}
                        </button>
                      </span>
                    </li>
                  }
                </ul>
              </div>
            }
          </section>
        }

        @if (pendingGroups().length > 0) {
          <section class="flex flex-col gap-4">
            <h1 class="font-brand text-base font-semibold text-ink">Aguardando OK</h1>
            @for (group of pendingGroups(); track group.accountId) {
              <div class="flex flex-col gap-3">
                <h2 class="font-brand text-sm font-semibold text-ink">{{ group.accountName }}</h2>
                <ul class="flex flex-col gap-2">
                  @for (a of group.items; track a.id) {
                    <li class="ui-panel-card--brand flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                      <span class="flex min-w-0 flex-col gap-1">
                        <app-ui-eyebrow>Aguardando seu OK@if (deadline(a.expiresAt); as d) { · {{ d }}}</app-ui-eyebrow>
                        <span class="font-semibold text-ink">
                          {{ typeLabel(a.type) }} {{ pendingTargetOf(a) }}
                        </span>
                        <span class="text-xs text-muted">{{ a.reason }}</span>
                      </span>
                      <span class="flex shrink-0 gap-2">
                        <button appButton variant="secondary" size="sm" [disabled]="resolving().has(a.id)" (click)="reject(a)">
                          Rejeitar
                        </button>
                        <button appButton size="sm" [disabled]="resolving().has(a.id)" (click)="approve(a)">
                          {{ resolving().has(a.id) ? 'Enviando…' : 'Aprovar' }}
                        </button>
                      </span>
                    </li>
                  }
                </ul>
              </div>
            }
          </section>
        }

        @if (revertibleGroups().length > 0) {
          <section class="flex flex-col gap-4">
            <h1 class="font-brand text-base font-semibold text-ink">Reversíveis</h1>
            @for (group of revertibleGroups(); track group.accountId) {
              <div class="flex flex-col gap-3">
                <h2 class="font-brand text-sm font-semibold text-ink">{{ group.accountName }}</h2>
                <ul class="flex flex-col gap-2">
                  @for (a of group.items; track a.toolCallId) {
                    <li class="flex flex-col gap-3 rounded-lg border border-line bg-panel px-4 py-3 sm:flex-row sm:items-start sm:justify-between">
                      <span class="flex min-w-0 flex-col gap-1">
                        <app-ui-eyebrow>Reversível</app-ui-eyebrow>
                        <span class="font-semibold text-ink">
                          {{ typeLabel(a.type) }} {{ revertibleTargetOf(a) }}
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
          </section>
        }
      }
    </div>
  `,
})
export class ApprovalsPage implements OnInit {
  // Marca: 1ª menção do agente apresenta o Roi (aposto).
  protected readonly emptyDescription = `Quando o ${AGENT_NAME}, seu agente de tráfego, propuser mudanças ou aplicar algo que ainda dá pra desfazer, aparece aqui.`;
  protected readonly agentName = AGENT_NAME;
  private readonly api = inject(ApprovalsApiService);
  private readonly draftsApi = inject(DraftsApiService);
  private readonly analysisApi = inject(AnalysisApiService);
  private readonly confirmDialog = inject(UiConfirmDialogService);

  protected readonly pendingGroups = signal<readonly AccountGroup<ApprovalOutput>[]>([]);
  protected readonly revertibleGroups = signal<readonly AccountGroup<RevertibleActionOutput>[]>([]);
  protected readonly draftGroups = signal<readonly AccountGroup<DraftApprovalOutput>[]>([]);
  private readonly pendingLoaded = signal(false);
  private readonly revertibleLoaded = signal(false);
  private readonly draftsLoaded = signal(false);
  protected readonly loaded = computed(
    () => this.pendingLoaded() && this.revertibleLoaded() && this.draftsLoaded(),
  );
  protected readonly resolving = signal<ReadonlySet<string>>(new Set());
  protected readonly reverting = signal<ReadonlySet<string>>(new Set());

  protected typeLabel = actionTypeLabel;
  protected deadline = deadlineText;
  protected pendingTargetOf = (a: ApprovalOutput): string =>
    entityTargetLabel(a.entityLevel, a.entityId, a.entityName);
  protected revertibleTargetOf = (a: RevertibleActionOutput): string =>
    entityTargetLabel(a.targetLevel, a.targetId, a.targetName);

  protected draftKindLabel = (d: DraftApprovalOutput): string =>
    d.kind === 'duplicate' ? 'Escalar vencedor' : 'Criar campanha';
  protected draftTitle = (d: DraftApprovalOutput): string =>
    d.kind === 'duplicate'
      ? `Duplicar ${this.sourceName(d)} com mais budget`
      : `Nova campanha${d.objective ? ` de ${conversionLabel(d.objective)}` : ''}`;
  /** Origem legível (nome do backend; senão traduz o nível, sem expor "level:id" técnico). */
  protected sourceName = (d: DraftApprovalOutput): string => {
    if (!d.sourceLabel) return 'o vencedor';
    const [level, id] = d.sourceLabel.split(':');
    const lvl = level === 'campaign' ? 'campanha' : level === 'adset' ? 'conjunto' : level ?? '';
    return id ? `${lvl} ${id}` : d.sourceLabel;
  };
  protected objectiveLabel = (o: string | null): string => (o ? conversionLabel(o) : '');
  protected money = money;

  ngOnInit(): void {
    this.api.listPending().subscribe({
      next: (rows) => {
        this.pendingGroups.set(groupByAccount(rows));
        this.pendingLoaded.set(true);
      },
      error: () => this.pendingLoaded.set(true),
    });
    this.api.listRevertible().subscribe({
      next: (rows) => {
        this.revertibleGroups.set(groupByAccount(rows));
        this.revertibleLoaded.set(true);
      },
      error: () => this.revertibleLoaded.set(true),
    });
    this.draftsApi.listPending().subscribe({
      next: (rows) => {
        this.draftGroups.set(groupByAccount(rows));
        this.draftsLoaded.set(true);
      },
      error: () => this.draftsLoaded.set(true),
    });
  }

  /** Aprovar rascunho: enfileira a saga de criação (mesma rota resolve). Otimista. */
  protected approveDraft(d: DraftApprovalOutput): void {
    this.markResolving(d.id);
    this.api.resolve(d.id, 'approve').subscribe({
      next: () => {
        this.removeDraft(d.id);
        toast.success('Enviado para criação. O agente cria em instantes.');
      },
      error: () => this.clearResolving(d.id),
    });
  }

  /** Recusar rascunho: descarta (nada é criado na Meta). */
  protected rejectDraft(d: DraftApprovalOutput): void {
    this.markResolving(d.id);
    this.api.resolve(d.id, 'reject').subscribe({
      next: () => {
        this.removeDraft(d.id);
        toast.success('Rascunho descartado');
      },
      error: () => this.clearResolving(d.id),
    });
  }

  private removeDraft(id: string): void {
    this.draftGroups.update((gs) =>
      gs.map((g) => ({ ...g, items: g.items.filter((x) => x.id !== id) })).filter((g) => g.items.length > 0),
    );
    this.clearResolving(id);
  }

  /** Aprovar: enfileira a aplicação (worker re-checa fresco + aplica). Otimista. */
  protected approve(a: ApprovalOutput): void {
    this.markResolving(a.id);
    this.api.resolve(a.id, 'approve').subscribe({
      next: () => {
        this.removePending(a.id);
        toast.success('Enviado para aplicação. O agente aplica em instantes.');
      },
      error: () => this.clearResolving(a.id),
    });
  }

  /** Rejeitar: descarta a sugestão (nada é aplicado na Meta). */
  protected reject(a: ApprovalOutput): void {
    this.markResolving(a.id);
    this.api.resolve(a.id, 'reject').subscribe({
      next: () => {
        this.removePending(a.id);
        toast.success('Sugestão descartada');
      },
      error: () => this.clearResolving(a.id),
    });
  }

  /** Reverter (por-conta, mesma rota da mini-surface). `force` = "mesmo assim" após drift. */
  protected async revert(a: RevertibleActionOutput, force = false): Promise<void> {
    const description = force && a.revertBlockedReason ? `${a.revertBlockedReason}. ${UNDO_WARNING}` : UNDO_WARNING;
    const confirmed = await this.confirmDialog.confirm({
      title: force ? 'Reverter mesmo assim?' : 'Reverter ação?',
      description,
      confirmLabel: 'Reverter',
      tone: 'warning',
    });
    if (!confirmed) return;
    this.markReverting(a.toolCallId);
    this.analysisApi.undoAction(a.accountId, a.toolCallId, force).subscribe({
      next: () => {
        this.removeRevertible(a.toolCallId);
        toast.success('Revertendo — a ação volta ao estado anterior');
      },
      error: () => this.clearReverting(a.toolCallId),
    });
  }

  private removePending(id: string): void {
    this.pendingGroups.update((gs) =>
      gs.map((g) => ({ ...g, items: g.items.filter((x) => x.id !== id) })).filter((g) => g.items.length > 0),
    );
    this.clearResolving(id);
  }

  private removeRevertible(toolCallId: string): void {
    this.revertibleGroups.update((gs) =>
      gs
        .map((g) => ({ ...g, items: g.items.filter((x) => x.toolCallId !== toolCallId) }))
        .filter((g) => g.items.length > 0),
    );
    this.clearReverting(toolCallId);
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

  private markReverting(id: string): void {
    this.reverting.update((s) => new Set(s).add(id));
  }

  private clearReverting(id: string): void {
    this.reverting.update((s) => {
      const next = new Set(s);
      next.delete(id);
      return next;
    });
  }
}
