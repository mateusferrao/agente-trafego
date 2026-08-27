import { DOCUMENT } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  computed,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideCalendar, lucideChevronLeft, lucideChevronRight } from '@ng-icons/lucide';

// Date field custom no design system: trigger + popup de calendário (substitui o
// <input type=date> nativo, cujo popup não é estilizável). Valor = ISO 'yyyy-mm-dd'.
interface DayCell {
  readonly iso: string;
  readonly label: number;
  readonly inMonth: boolean;
  readonly isToday: boolean;
  readonly isSelected: boolean;
}

const WEEKDAYS = ['D', 'S', 'T', 'Q', 'Q', 'S', 'S'] as const;
const MONTH_FMT = new Intl.DateTimeFormat('pt-BR', { month: 'long', year: 'numeric' });

const pad = (n: number): string => String(n).padStart(2, '0');
const toIso = (y: number, m: number, d: number): string => `${y}-${pad(m + 1)}-${pad(d)}`;

@Component({
  selector: 'app-ui-date-field',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [NgIcon],
  providers: [provideIcons({ lucideCalendar, lucideChevronLeft, lucideChevronRight })],
  host: { class: 'relative block' },
  template: `
    <button
      type="button"
      class="ui-cal__trigger"
      [class.ui-cal__trigger--placeholder]="!display()"
      [attr.aria-expanded]="open()"
      [attr.aria-label]="ariaLabel()"
      (click)="toggle()"
    >
      <span>{{ display() || placeholder() }}</span>
      <ng-icon name="lucideCalendar" size="16" class="text-muted" aria-hidden="true" />
    </button>

    @if (open()) {
      <div
        class="ui-cal"
        [class.ui-cal--end]="align() === 'end'"
        role="dialog"
        aria-modal="true"
        [attr.aria-label]="ariaLabel()"
        (keydown.escape)="close()"
      >
        <div class="ui-cal__head">
          <button type="button" class="ui-cal__nav" aria-label="Mês anterior" (click)="shiftMonth(-1)">
            <ng-icon name="lucideChevronLeft" size="16" aria-hidden="true" />
          </button>
          <span class="ui-cal__month">{{ monthLabel() }}</span>
          <button type="button" class="ui-cal__nav" aria-label="Próximo mês" (click)="shiftMonth(1)">
            <ng-icon name="lucideChevronRight" size="16" aria-hidden="true" />
          </button>
        </div>
        <div class="ui-cal__weekdays">
          @for (w of weekdays; track $index) {
            <span class="ui-cal__wd">{{ w }}</span>
          }
        </div>
        <div class="ui-cal__grid">
          @for (cell of cells(); track cell.iso) {
            <button
              type="button"
              class="ui-cal__day"
              [class.ui-cal__day--out]="!cell.inMonth"
              [class.ui-cal__day--today]="cell.isToday"
              [class.ui-cal__day--selected]="cell.isSelected"
              (click)="pick(cell)"
            >
              {{ cell.label }}
            </button>
          }
        </div>
        <div class="ui-cal__foot">
          <button type="button" (click)="clear()">Limpar</button>
          <button type="button" (click)="pickToday()">Hoje</button>
        </div>
      </div>
    }
  `,
})
export class UiDateField {
  readonly value = input<string | null>(null);
  readonly placeholder = input('dd/mm/aaaa');
  readonly ariaLabel = input('Escolher data');
  // Lado de ancoragem do popup: 'start' abre pra direita (default), 'end' pra
  // esquerda — usar 'end' em campos próximos da borda direita (não vaza a tela).
  readonly align = input<'start' | 'end'>('start');
  readonly valueChange = output<string>();

  protected readonly weekdays = WEEKDAYS;
  protected readonly open = signal(false);
  // Mês/ano em exibição (inicia no valor ou no mês corrente).
  private readonly view = signal(this.initialView());

  constructor() {
    // Fecha ao clicar fora (captura; o clique no trigger não fecha pois está dentro do host).
    const host = inject<ElementRef<HTMLElement>>(ElementRef);
    const doc = inject(DOCUMENT);
    const onDocClick = (e: Event): void => {
      if (this.open() && !host.nativeElement.contains(e.target as Node)) this.close();
    };
    doc.addEventListener('click', onDocClick, true);
    inject(DestroyRef).onDestroy(() => doc.removeEventListener('click', onDocClick, true));
  }

  protected readonly display = computed(() => {
    const v = this.parse(this.value());
    return v ? `${pad(v.d)}/${pad(v.m + 1)}/${v.y}` : '';
  });

  protected readonly monthLabel = computed(() => {
    const { y, m } = this.view();
    return MONTH_FMT.format(new Date(y, m, 1));
  });

  protected readonly cells = computed<DayCell[]>(() => {
    const { y, m } = this.view();
    const selected = this.value() ?? '';
    const now = new Date();
    const todayIso = toIso(now.getFullYear(), now.getMonth(), now.getDate());
    const first = new Date(y, m, 1);
    const start = 1 - first.getDay(); // domingo antes/na 1ª
    const out: DayCell[] = [];
    for (let i = 0; i < 42; i++) {
      const d = new Date(y, m, start + i);
      const iso = toIso(d.getFullYear(), d.getMonth(), d.getDate());
      out.push({
        iso,
        label: d.getDate(),
        inMonth: d.getMonth() === m,
        isToday: iso === todayIso,
        isSelected: iso === selected,
      });
    }
    return out;
  });

  protected toggle(): void {
    if (!this.open()) this.view.set(this.initialView());
    this.open.update((o) => !o);
  }
  protected close(): void {
    this.open.set(false);
  }
  protected shiftMonth(delta: number): void {
    const { y, m } = this.view();
    const d = new Date(y, m + delta, 1);
    this.view.set({ y: d.getFullYear(), m: d.getMonth() });
  }
  protected pick(cell: DayCell): void {
    this.valueChange.emit(cell.iso);
    this.close();
  }
  protected pickToday(): void {
    const now = new Date();
    this.pick({
      iso: toIso(now.getFullYear(), now.getMonth(), now.getDate()),
      label: now.getDate(),
      inMonth: true,
      isToday: true,
      isSelected: false,
    });
  }
  protected clear(): void {
    this.valueChange.emit('');
    this.close();
  }

  private initialView(): { y: number; m: number } {
    const v = this.parse(this.value());
    if (v) return { y: v.y, m: v.m };
    const now = new Date();
    return { y: now.getFullYear(), m: now.getMonth() };
  }

  private parse(s: string | null | undefined): { y: number; m: number; d: number } | null {
    if (!s) return null;
    const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(s);
    if (!match) return null;
    return { y: Number(match[1]), m: Number(match[2]) - 1, d: Number(match[3]) };
  }
}
