import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { UiDateField, UiEmptyState, UiPageHeader, UiSpinner } from '@ui';
import { OrgApiService } from '@core/api/org-api.service';
import type { CostsOutput } from '@core/api';

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

const MAX_TYPE_SLICES = 6; // demais tipos → "Outros" (nunca cicla a paleta de tokens)
const DONUT_LEN = 100; // pathLength → dasharray em % (sem π)

interface Preset {
  readonly key: string;
  readonly label: string;
}
const PRESETS: readonly Preset[] = [
  { key: 'this-month', label: 'Este mês' },
  { key: 'last-month', label: 'Mês passado' },
  { key: '7d', label: '7 dias' },
  { key: '30d', label: '30 dias' },
  { key: '90d', label: '90 dias' },
  { key: 'year', label: 'Este ano' },
];

interface SeriePoint {
  readonly x: number;
  readonly y: number;
}
interface TypeSlice {
  readonly label: string;
  readonly color: string;
  readonly cost: number;
  readonly pct: number;
  readonly len: number;
  readonly offset: number;
}

/** "YYYY-MM-DD" a partir de um Date (local). */
function ymd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
/** Range inclusivo (since,until) de um preset. */
function presetRange(key: string): { since: string; until: string } {
  const today = new Date();
  const until = ymd(today);
  const start = new Date(today);
  switch (key) {
    case 'this-month':
      return { since: ymd(new Date(today.getFullYear(), today.getMonth(), 1)), until };
    case 'last-month': {
      const first = new Date(today.getFullYear(), today.getMonth() - 1, 1);
      const last = new Date(today.getFullYear(), today.getMonth(), 0);
      return { since: ymd(first), until: ymd(last) };
    }
    case '7d':
      start.setDate(start.getDate() - 6);
      return { since: ymd(start), until };
    case '90d':
      start.setDate(start.getDate() - 89);
      return { since: ymd(start), until };
    case 'year':
      return { since: ymd(new Date(today.getFullYear(), 0, 1)), until };
    case '30d':
    default:
      start.setDate(start.getDate() - 29);
      return { since: ymd(start), until };
  }
}

/**
 * Custos (6b) — visão do OWNER: COGS por período (range por dia) com gráficos:
 * série diária (área), por conta (barras ranqueadas) e por tipo (donut + rótulos).
 * Charts em SVG/HTML com design tokens (sem lib). Não é o preço do cliente.
 */
@Component({
  selector: 'app-costs-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, UiDateField, UiEmptyState, UiPageHeader, UiSpinner],
  template: `
    <div class="flex flex-col gap-6 overflow-x-clip">
      <app-ui-page-header
        title="Custos"
        subtitle="Custo operacional (COGS do provedor de IA) por período. Não é o preço do cliente."
      />

      <!-- Período: presets + range personalizado -->
      <div class="flex flex-wrap items-end gap-3">
        <div class="flex flex-wrap gap-1 rounded-md border border-line bg-panel p-1">
          @for (p of presets; track p.key) {
            <button
              type="button"
              class="rounded-sm px-2.5 py-1 text-xs font-medium transition"
              [class.bg-accent-soft]="mode() === p.key"
              [class.text-accent-strong]="mode() === p.key"
              [class.text-muted]="mode() !== p.key"
              (click)="setPreset(p.key)"
            >
              {{ p.label }}
            </button>
          }
        </div>
        <div class="flex items-end gap-2">
          <label class="flex flex-col gap-0.5 text-[11px] text-muted">
            De
            <app-ui-date-field
              class="w-36"
              [value]="since()"
              ariaLabel="Data inicial"
              (valueChange)="setSince($event)"
            />
          </label>
          <label class="flex flex-col gap-0.5 text-[11px] text-muted">
            Até
            <app-ui-date-field
              class="w-36"
              align="end"
              [value]="until()"
              ariaLabel="Data final"
              (valueChange)="setUntil($event)"
            />
          </label>
        </div>
      </div>

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
        <!-- KPIs: total + gasto vs cap -->
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

        @if (d.totalCostUsd === 0) {
          <app-ui-empty-state
            brand
            title="Sem custo no período"
            description="Nenhum custo operacional foi registrado no período selecionado."
          />
        } @else {
          <!-- Série diária (área) -->
          <section class="flex flex-col gap-3 rounded-lg border border-line bg-panel p-5">
            <div class="flex items-baseline justify-between">
              <h2 class="font-brand text-sm font-semibold text-ink">Custo por dia</h2>
              <span class="text-xs text-muted">pico {{ money(serieMax()) }}</span>
            </div>
            @if (serie().length >= 2) {
              <!-- área + camada de hover (crosshair + tooltip por dia). -->
              <div class="relative h-40 w-full overflow-hidden">
                <svg viewBox="0 0 100 40" preserveAspectRatio="none" class="h-full w-full" role="img" aria-label="Custo por dia no período">
                  <polygon [attr.points]="areaPoints()" [attr.fill]="accentVar" fill-opacity="0.15" />
                  <polyline
                    [attr.points]="linePoints()"
                    fill="none"
                    [attr.stroke]="accentVar"
                    stroke-width="1.5"
                    vector-effect="non-scaling-stroke"
                  />
                </svg>
                @if (hovered(); as h) {
                  <!-- linha guia + ponto + tooltip (posicionados por %, sem cor inline). -->
                  <div class="pointer-events-none absolute top-0 bottom-0 w-px bg-line" [style.left.%]="h.xPct"></div>
                  <div
                    class="pointer-events-none absolute size-2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-accent"
                    [style.left.%]="h.xPct"
                    [style.top.%]="h.yPct"
                  ></div>
                  <div
                    class="pointer-events-none absolute -translate-x-1/2 -translate-y-full rounded-md border border-line bg-panel px-2 py-1 text-[11px] whitespace-nowrap shadow-card"
                    [style.left.%]="h.xPct"
                    [style.top.%]="h.yPct"
                  >
                    <span class="text-muted">{{ h.date }}</span>
                    <span class="ml-1.5 font-medium text-ink">{{ money(h.cost) }}</span>
                  </div>
                }
                <!-- overlay transparente que captura o mouse (offsetX → dia). -->
                <div
                  class="absolute inset-0 cursor-crosshair"
                  (mousemove)="onHover($event)"
                  (mouseleave)="hoveredIndex.set(null)"
                ></div>
              </div>
              <div class="flex justify-between text-[11px] text-muted">
                <span>{{ dayLabel(d.since) }}</span>
                <span>{{ dayLabel(d.until) }}</span>
              </div>
            } @else {
              <p class="text-xs text-muted">Poucos dias com custo para desenhar a curva.</p>
            }
          </section>

          <div class="grid min-w-0 gap-6 lg:grid-cols-2">
            <!-- Por conta (barras ranqueadas) -->
            <section class="flex min-w-0 flex-col gap-3 rounded-lg border border-line bg-panel p-5">
              <h2 class="font-brand text-sm font-semibold text-ink">Por conta</h2>
              @if (d.byAccount.length === 0) {
                <p class="text-sm text-muted">Sem custo atribuível a contas neste período.</p>
              } @else {
                <ul class="flex flex-col gap-1">
                  @for (a of d.byAccount; track a.accountId; let i = $index) {
                    <li
                      class="flex flex-col gap-1 rounded-md p-1.5 transition"
                      [class.bg-soft]="hoveredAcct() === i"
                      (mouseenter)="hoveredAcct.set(i)"
                      (mouseleave)="hoveredAcct.set(null)"
                    >
                      <div class="flex items-baseline justify-between gap-3 text-sm">
                        <span class="truncate text-ink">{{ a.accountName ?? a.accountId }}</span>
                        <span class="shrink-0 font-medium text-ink">
                          {{ money(a.costUsd) }}
                          @if (hoveredAcct() === i) {
                            <span class="text-muted">· {{ acctSharePct(a.costUsd) }}%</span>
                          }
                        </span>
                      </div>
                      <div class="h-1.5 w-full overflow-hidden rounded-full bg-soft">
                        <div class="h-full rounded-full bg-accent" [style.width.%]="acctPct(a.costUsd)"></div>
                      </div>
                    </li>
                  }
                </ul>
              }
              @if (d.unattributedCostUsd > 0) {
                <p class="text-xs text-muted">+ {{ money(d.unattributedCostUsd) }} sem conta (chat / conversas).</p>
              }
            </section>

            <!-- Por tipo (donut + legenda com rótulos) -->
            <section class="flex min-w-0 flex-col gap-3 rounded-lg border border-line bg-panel p-5">
              <h2 class="font-brand text-sm font-semibold text-ink">Por tipo</h2>
              <div class="flex min-w-0 items-center gap-5">
                <svg viewBox="0 0 42 42" class="h-28 w-28 shrink-0" role="img" aria-label="Custo por tipo">
                  <g transform="rotate(-90 21 21)">
                    @for (s of typeSlices(); track s.label; let i = $index) {
                      <circle
                        cx="21"
                        cy="21"
                        r="15.915"
                        fill="transparent"
                        stroke-width="8"
                        pathLength="100"
                        class="cursor-pointer transition-opacity"
                        [attr.opacity]="dimSlice(i) ? 0.35 : 1"
                        [attr.stroke]="s.color"
                        [attr.stroke-dasharray]="s.len + ' ' + (100 - s.len)"
                        [attr.stroke-dashoffset]="-s.offset"
                        (mouseenter)="hoveredType.set(i)"
                        (mouseleave)="hoveredType.set(null)"
                      />
                    }
                  </g>
                </svg>
                <ul class="flex min-w-0 flex-1 flex-col gap-0.5">
                  @for (s of typeSlices(); track s.label; let i = $index) {
                    <li
                      class="flex items-center gap-2 rounded p-1 text-xs transition"
                      [class.bg-soft]="hoveredType() === i"
                      (mouseenter)="hoveredType.set(i)"
                      (mouseleave)="hoveredType.set(null)"
                    >
                      <span class="size-2.5 shrink-0 rounded-full" [style.background]="s.color"></span>
                      <span class="truncate text-ink">{{ s.label }}</span>
                      <span class="ml-auto shrink-0 text-muted">{{ s.pct }}% · {{ money(s.cost) }}</span>
                    </li>
                  }
                </ul>
              </div>
            </section>
          </div>
        }
      }
    </div>
  `,
})
export class CostsPage {
  private readonly orgApi = inject(OrgApiService);

  protected readonly presets = PRESETS;
  protected readonly mode = signal<string>('30d');
  protected readonly since = signal(presetRange('30d').since);
  protected readonly until = signal(presetRange('30d').until);

  protected readonly data = signal<CostsOutput | null>(null);
  protected readonly loading = signal(true);
  protected readonly failed = signal(false);

  protected readonly money = usd;
  /** Token da cor accent p/ os marks SVG (via [attr.*] — tokens:check proíbe style= inline). */
  protected readonly accentVar = 'var(--color-accent)';

  constructor() {
    this.load();
  }

  protected setPreset(key: string): void {
    const r = presetRange(key);
    this.mode.set(key);
    this.since.set(r.since);
    this.until.set(r.until);
    this.load();
  }

  protected setSince(v: string): void {
    if (!v) return;
    this.mode.set('custom');
    this.since.set(v);
    this.load();
  }

  protected setUntil(v: string): void {
    if (!v) return;
    this.mode.set('custom');
    this.until.set(v);
    this.load();
  }

  protected load(): void {
    this.loading.set(true);
    this.failed.set(false);
    this.orgApi.costs(this.since(), this.until()).subscribe({
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

  // ─── gasto vs cap ─────────────────────────────────────────────────────
  protected capPct(d: CostsOutput): number {
    return d.capUsd <= 0 ? 0 : Math.min(100, (d.totalCostUsd / d.capUsd) * 100);
  }
  protected overCap(d: CostsOutput): boolean {
    return d.capUsd > 0 && d.totalCostUsd > d.capUsd;
  }

  // ─── série diária (área) ──────────────────────────────────────────────
  private readonly points = computed<SeriePoint[]>(() => {
    const days = this.data()?.byDay ?? [];
    if (days.length < 2) return [];
    const max = Math.max(...days.map((p) => p.costUsd), 0.000001);
    const n = days.length;
    return days.map((p, i) => ({ x: (i / (n - 1)) * 100, y: 40 - (p.costUsd / max) * 40 }));
  });
  protected serie(): SeriePoint[] {
    return this.points();
  }
  protected serieMax(): number {
    return Math.max(...(this.data()?.byDay ?? []).map((p) => p.costUsd), 0);
  }
  protected linePoints(): string {
    return this.points()
      .map((p) => `${p.x.toFixed(2)},${p.y.toFixed(2)}`)
      .join(' ');
  }
  protected areaPoints(): string {
    const pts = this.points();
    if (pts.length < 2) return '';
    return `0,40 ${this.linePoints()} 100,40`;
  }

  // hover na série: mapeia offsetX → dia; tooltip/crosshair posicionados por %.
  protected readonly hoveredIndex = signal<number | null>(null);
  protected onHover(e: MouseEvent): void {
    const el = e.currentTarget as HTMLElement;
    const n = this.data()?.byDay.length ?? 0;
    if (n < 2 || el.clientWidth === 0) return;
    const ratio = Math.min(1, Math.max(0, e.offsetX / el.clientWidth));
    this.hoveredIndex.set(Math.round(ratio * (n - 1)));
  }
  protected hovered(): { xPct: number; yPct: number; date: string; cost: number } | null {
    const idx = this.hoveredIndex();
    if (idx === null) return null;
    const p = this.points()[idx];
    const day = (this.data()?.byDay ?? [])[idx];
    if (!p || !day) return null;
    return { xPct: p.x, yPct: (p.y / 40) * 100, date: this.dayLabel(day.date), cost: day.costUsd };
  }

  // ─── por conta (barras) ───────────────────────────────────────────────
  protected readonly hoveredAcct = signal<number | null>(null);
  private acctMax(): number {
    return Math.max(...(this.data()?.byAccount ?? []).map((a) => a.costUsd), 0.000001);
  }
  protected acctPct(cost: number): number {
    return Math.max(2, (cost / this.acctMax()) * 100); // piso 2% p/ barra visível
  }
  /** % da conta sobre o total atribuído a contas (revelado no hover). */
  protected acctSharePct(cost: number): number {
    const total = (this.data()?.byAccount ?? []).reduce((s, a) => s + a.costUsd, 0) || 1;
    return Math.round((cost / total) * 100);
  }

  // ─── por tipo (donut) hover ───────────────────────────────────────────
  protected readonly hoveredType = signal<number | null>(null);
  /** Esmaece as fatias não-focadas quando há hover (destaca a focada). */
  protected dimSlice(i: number): boolean {
    const h = this.hoveredType();
    return h !== null && h !== i;
  }

  // ─── por tipo (donut + legenda) ───────────────────────────────────────
  protected typeSlices(): TypeSlice[] {
    const byType = this.data()?.byType ?? {};
    const rows = Object.entries(byType)
      .map(([type, cost]) => ({ type, cost: cost as number }))
      .filter((r) => r.cost > 0)
      .sort((a, b) => b.cost - a.cost);
    const total = rows.reduce((s, r) => s + r.cost, 0) || 1;

    // top N + "Outros" (nunca cicla a paleta de tokens além de cat-1..7).
    const head = rows.slice(0, MAX_TYPE_SLICES);
    const tail = rows.slice(MAX_TYPE_SLICES);
    const merged = [...head];
    if (tail.length) merged.push({ type: '__outros__', cost: tail.reduce((s, r) => s + r.cost, 0) });

    let offset = 0;
    return merged.map((r, i) => {
      const pct = (r.cost / total) * 100;
      const len = (pct / 100) * DONUT_LEN;
      const slice: TypeSlice = {
        label: r.type === '__outros__' ? 'Outros' : (TYPE_LABELS[r.type] ?? r.type),
        color: `var(--color-cat-${(i % 7) + 1})`,
        cost: r.cost,
        pct: Math.round(pct),
        len,
        offset,
      };
      offset += len;
      return slice;
    });
  }

  // ─── datas ────────────────────────────────────────────────────────────
  protected dayLabel(iso: string): string {
    const [y, m, d] = iso.split('-');
    return `${d}/${m}/${y}`;
  }
}
