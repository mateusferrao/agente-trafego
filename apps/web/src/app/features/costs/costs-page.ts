import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { UiPageHeader, UiSpinner } from '@ui';
import { OrgApiService } from '@core/api/org-api.service';
import type { CostsOutput } from '@core/api';

const MONTHS_BACK = 6;

/** Formata USD (COGS do provider). Locale pt-BR, moeda USD. */
function usd(value: number): string {
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'USD' }).format(value);
}

/** Rótulos legíveis dos tipos internos de usage_events (§UX: sem jargão cru). */
const TYPE_LABELS: Readonly<Record<string, string>> = {
  unit: 'Análise por anúncio',
  synthesis: 'Síntese da conta',
  vision: 'Visão de criativo',
  review: 'Revisão',
  message: 'Mensagem (WhatsApp)',
  conversation: 'Chat',
  action_applied: 'Ação aplicada',
  llm: 'LLM (outros)',
};

/**
 * Custos (6b) — visão do OWNER: custo operacional (COGS do provider) por conta e
 * período + gasto vs cap. NÃO é o preço do cliente (markup = fast-follow).
 */
@Component({
  selector: 'app-costs-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, UiPageHeader, UiSpinner],
  template: `
    <div class="flex flex-col gap-6">
      <app-ui-page-header
        title="Custos"
        subtitle="Custo operacional (COGS do provedor de IA) por conta e período. Não é o preço do cliente."
      >
        <select
          actions
          aria-label="Período"
          class="rounded-md border border-line bg-panel px-3 py-1.5 text-sm text-ink"
          [ngModel]="period()"
          (ngModelChange)="setPeriod($event)"
        >
          @for (p of periods; track p) {
            <option [value]="p">{{ periodLabel(p) }}</option>
          }
        </select>
      </app-ui-page-header>

      @if (loading()) {
        <div class="flex items-center justify-center gap-3 rounded-lg border border-line bg-panel p-10 text-sm text-muted">
          <app-ui-spinner [size]="20" [stroke]="2" aria-hidden="true" /> Carregando…
        </div>
      } @else if (failed()) {
        <div class="flex flex-col items-start gap-3 rounded-lg border border-line bg-panel p-6">
          <p class="text-sm text-ink">Não consegui carregar os custos agora.</p>
          <button class="text-sm font-medium text-accent-strong hover:underline" type="button" (click)="load()">
            Tentar de novo
          </button>
        </div>
      } @else if (data(); as d) {
        <!-- Total + gasto vs cap -->
        <section class="flex flex-col gap-2 rounded-lg border border-line bg-panel p-5">
          <span class="text-sm text-muted">Total no período</span>
          <span class="text-2xl font-semibold text-ink">{{ money(d.totalCostUsd) }}</span>
          @if (d.capUsd > 0) {
            <div class="mt-1 flex flex-col gap-1">
              <div class="h-2 w-full overflow-hidden rounded-full bg-soft">
                <div class="h-full rounded-full bg-accent" [style.width.%]="capPct(d)"></div>
              </div>
              <span class="text-xs" [class.text-muted]="!overCap(d)" [class.text-danger-strong]="overCap(d)">
                {{ money(d.totalCostUsd) }} de {{ money(d.capUsd) }} (cap do período)
              </span>
            </div>
          }
        </section>

        <!-- Por conta -->
        <section class="flex flex-col gap-3">
          <h2 class="font-brand text-sm font-semibold text-ink">Por conta</h2>
          @if (d.byAccount.length === 0) {
            <p class="rounded-lg border border-line bg-panel p-4 text-sm text-muted">
              Sem custo atribuível a contas neste período.
            </p>
          } @else {
            <ul class="flex flex-col gap-2">
              @for (a of d.byAccount; track a.accountId) {
                <li class="flex items-center justify-between gap-3 rounded-lg border border-line bg-panel p-3 text-sm">
                  <span class="truncate text-ink">{{ a.accountName ?? a.accountId }}</span>
                  <span class="shrink-0 font-medium text-ink">{{ money(a.costUsd) }}</span>
                </li>
              }
            </ul>
          }
          @if (d.unattributedCostUsd > 0) {
            <p class="text-xs text-muted">
              + {{ money(d.unattributedCostUsd) }} sem conta associada (ex: chat / conversas).
            </p>
          }
        </section>

        <!-- Por tipo -->
        <section class="flex flex-col gap-3">
          <h2 class="font-brand text-sm font-semibold text-ink">Por tipo</h2>
          <ul class="flex flex-col gap-2">
            @for (t of typeRows(d); track t.type) {
              <li class="flex items-center justify-between gap-3 rounded-lg border border-line bg-panel p-3 text-sm">
                <span class="text-ink">{{ typeLabel(t.type) }}</span>
                <span class="shrink-0 font-medium text-ink">{{ money(t.cost) }}</span>
              </li>
            }
          </ul>
        </section>
      }
    </div>
  `,
})
export class CostsPage {
  private readonly orgApi = inject(OrgApiService);

  protected readonly periods = buildPeriods();
  protected readonly period = signal(this.periods[0]!);
  protected readonly data = signal<CostsOutput | null>(null);
  protected readonly loading = signal(true);
  protected readonly failed = signal(false);

  protected readonly money = usd;

  constructor() {
    this.load();
  }

  protected setPeriod(p: string): void {
    this.period.set(p);
    this.load();
  }

  protected load(): void {
    this.loading.set(true);
    this.failed.set(false);
    this.orgApi.costs(this.period()).subscribe({
      next: (d) => {
        this.data.set(d);
        this.loading.set(false);
      },
      error: () => {
        this.failed.set(true);
        this.loading.set(false);
      },
    });
  }

  protected capPct(d: CostsOutput): number {
    if (d.capUsd <= 0) return 0;
    return Math.min(100, (d.totalCostUsd / d.capUsd) * 100);
  }

  protected overCap(d: CostsOutput): boolean {
    return d.capUsd > 0 && d.totalCostUsd > d.capUsd;
  }

  protected typeLabel(type: string): string {
    return TYPE_LABELS[type] ?? type;
  }

  /** "YYYY-MM" → "agosto de 2026" (pt-BR). */
  protected periodLabel(period: string): string {
    const [y, m] = period.split('-').map(Number);
    if (!y || !m) return period;
    return new Intl.DateTimeFormat('pt-BR', { month: 'long', year: 'numeric' }).format(
      new Date(Date.UTC(y, m - 1, 1)),
    );
  }

  protected typeRows(d: CostsOutput): readonly { type: string; cost: number }[] {
    return Object.entries(d.byType)
      .map(([type, cost]) => ({ type, cost: cost as number }))
      .filter((r) => r.cost > 0)
      .sort((a, b) => b.cost - a.cost);
  }
}

/** Últimos N meses como "YYYY-MM" (mais recente primeiro). Sem libs de data. */
function buildPeriods(): readonly string[] {
  const now = new Date();
  const out: string[] = [];
  for (let i = 0; i < MONTHS_BACK; i += 1) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    out.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`);
  }
  return out;
}
