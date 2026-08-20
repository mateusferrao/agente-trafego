import { ChangeDetectionStrategy, Component, type OnInit, inject, signal } from '@angular/core';
import { provideIcons } from '@ng-icons/core';
import { heroCheckCircle } from '@ng-icons/heroicons/outline';
import { toast } from 'ngx-sonner';
import { UiBadge, UiButton, UiEmptyState, UiPageHeader } from '@ui';
import { ApprovalsApiService } from '@core/api/approvals-api.service';
import type { ApprovalOutput } from '@core/api/generated';
import { actionTypeLabel, deadlineText, entityTargetLabel } from '@app/shared/action-format';

interface AccountGroup {
  readonly accountId: string;
  readonly accountName: string;
  readonly items: readonly ApprovalOutput[];
}

/** Agrupa as pendentes por conta (caixa de entrada legível p/ gestor multi-conta). */
function groupByAccount(rows: readonly ApprovalOutput[]): AccountGroup[] {
  const byId = new Map<string, AccountGroup & { items: ApprovalOutput[] }>();
  for (const r of rows) {
    const g = byId.get(r.accountId);
    if (g) g.items.push(r);
    else byId.set(r.accountId, { accountId: r.accountId, accountName: r.accountName, items: [r] });
  }
  return [...byId.values()];
}

/**
 * Aprovações = ações que aguardam o OK humano (HITL — CLAUDE.md §7/§8), cross-conta.
 * Corte 1 (5b): lista as pendentes de `approvals` com o prazo; aprovar/rejeitar chega
 * no corte seguinte (aqui é a caixa de entrada do gestor multi-conta).
 */
@Component({
  selector: 'app-approvals-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [UiEmptyState, UiPageHeader, UiBadge, UiButton],
  providers: [provideIcons({ heroCheckCircle })],
  template: `
    <div class="flex flex-col gap-8">
      <app-ui-page-header
        title="Aprovações"
        subtitle="Ações que aguardam seu OK antes de serem aplicadas."
      />

      @if (loaded() && groups().length === 0) {
        <app-ui-empty-state
          icon="heroCheckCircle"
          title="Nada aguardando OK"
          description="Quando o agente propuser mudanças que precisam da sua confirmação, elas aparecem aqui."
        />
      } @else {
        @for (group of groups(); track group.accountId) {
          <section class="flex flex-col gap-3">
            <h2 class="font-brand text-sm font-semibold text-ink">{{ group.accountName }}</h2>
            <ul class="flex flex-col gap-2">
              @for (a of group.items; track a.id) {
                <li class="flex items-start justify-between gap-3 rounded-lg border border-line bg-panel px-4 py-3">
                  <span class="flex min-w-0 flex-col gap-0.5">
                    <span class="text-sm text-ink">
                      <span class="font-medium">{{ typeLabel(a.type) }}</span> {{ targetOf(a) }}
                    </span>
                    <span class="text-xs text-muted">{{ a.reason }}</span>
                    @if (deadline(a.expiresAt); as d) {
                      <span appBadge tone="neutral" size="xs" class="mt-1 w-fit">⏳ {{ d }}</span>
                    }
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
          </section>
        }
      }
    </div>
  `,
})
export class ApprovalsPage implements OnInit {
  private readonly api = inject(ApprovalsApiService);

  protected readonly groups = signal<readonly AccountGroup[]>([]);
  protected readonly loaded = signal(false);
  protected readonly resolving = signal<ReadonlySet<string>>(new Set());

  protected typeLabel = actionTypeLabel;
  protected deadline = deadlineText;
  protected targetOf = (a: ApprovalOutput): string =>
    entityTargetLabel(a.entityLevel, a.entityId, a.entityName);

  ngOnInit(): void {
    this.api.listPending().subscribe({
      next: (rows) => {
        this.groups.set(groupByAccount(rows));
        this.loaded.set(true);
      },
      error: () => this.loaded.set(true),
    });
  }

  /** Aprovar: enfileira a aplicação (worker re-checa fresco + aplica). Otimista. */
  protected approve(a: ApprovalOutput): void {
    this.markResolving(a.id);
    this.api.resolve(a.id, 'approve').subscribe({
      next: () => {
        this.remove(a.id);
        toast.success('Enviado para aplicação — o agente aplica em instantes');
      },
      error: () => this.clearResolving(a.id),
    });
  }

  /** Rejeitar: descarta a sugestão (nada é aplicado na Meta). */
  protected reject(a: ApprovalOutput): void {
    this.markResolving(a.id);
    this.api.resolve(a.id, 'reject').subscribe({
      next: () => {
        this.remove(a.id);
        toast.success('Sugestão descartada');
      },
      error: () => this.clearResolving(a.id),
    });
  }

  private remove(id: string): void {
    this.groups.update((gs) =>
      gs
        .map((g) => ({ ...g, items: g.items.filter((x) => x.id !== id) }))
        .filter((g) => g.items.length > 0),
    );
    this.clearResolving(id);
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
