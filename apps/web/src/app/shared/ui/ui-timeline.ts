// ui-timeline (net-new, 6a) — feed vertical de atividade AGRUPADO POR DIA.
// Presentacional puro: recebe eventos já mapeados (view-model), sem saber da API.
// Cada evento = ícone (por tipo) + título + detalhe + badge (tom+texto) + horário;
// eventos com `children` (ex: recomendações de uma análise) expandem/recolhem.

import { ChangeDetectionStrategy, Component, computed, input, signal } from "@angular/core";
import { NgIcon, provideIcons } from "@ng-icons/core";
import {
  lucideUndo2,
  lucideZap,
  lucideCircleCheck,
  lucideChevronDown,
  lucideClock,
  lucideTriangleAlert,
  lucideActivity,
  lucideCircleX,
} from "@ng-icons/lucide";
import { UiBadge } from "./ui-badge";

export type TimelineTone = "success" | "warning" | "danger" | "info" | "neutral" | "accent";

export interface TimelineChildVm {
  readonly id: string;
  readonly title: string;
  readonly badge?: string | null;
  readonly tone?: TimelineTone;
}

export interface TimelineEventVm {
  readonly id: string;
  /** ISO timestamp. */
  readonly at: string;
  /** nome do ícone lucide (ver provideIcons abaixo). */
  readonly icon: string;
  readonly title: string;
  readonly detail?: string | null;
  readonly badge?: string | null;
  readonly tone?: TimelineTone;
  /** filhos expansíveis (ex: recomendações do run — híbrido expansível). */
  readonly children?: readonly TimelineChildVm[];
}

interface DayGroup {
  readonly day: string;
  readonly label: string;
  readonly items: readonly TimelineEventVm[];
}

const DAY_FMT = new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "long" });
const TIME_FMT = new Intl.DateTimeFormat("pt-BR", { hour: "2-digit", minute: "2-digit" });

@Component({
  selector: "app-ui-timeline",
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [NgIcon, UiBadge],
  providers: [
    provideIcons({
      lucideUndo2,
      lucideZap,
      lucideCircleCheck,
      lucideChevronDown,
      lucideClock,
      lucideTriangleAlert,
      lucideActivity,
      lucideCircleX,
    }),
  ],
  template: `
    <div class="flex flex-col gap-6">
      @for (group of groups(); track group.day) {
        <section class="flex flex-col gap-3">
          <h3 class="text-xs font-semibold uppercase tracking-wide text-muted">{{ group.label }}</h3>
          <ol class="flex flex-col gap-2">
            @for (event of group.items; track event.id) {
              <li class="flex gap-3 rounded-lg border border-line bg-panel p-3">
                <span class="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full bg-soft text-ink">
                  <ng-icon [name]="event.icon" size="16" aria-hidden="true" />
                </span>
                <div class="flex min-w-0 flex-1 flex-col gap-1">
                  <div class="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <span class="text-sm font-medium text-ink">{{ event.title }}</span>
                    @if (event.badge) {
                      <span appBadge [tone]="event.tone ?? 'neutral'" size="sm">{{ event.badge }}</span>
                    }
                    <span class="ml-auto text-xs text-muted">{{ timeLabel(event.at) }}</span>
                  </div>
                  @if (event.detail) {
                    <p class="text-sm text-muted">{{ event.detail }}</p>
                  }
                  @if (event.children && event.children.length > 0) {
                    <button
                      type="button"
                      class="mt-1 inline-flex items-center gap-1 self-start text-xs font-medium text-accent-strong transition hover:text-ink"
                      [attr.aria-expanded]="isOpen(event.id)"
                      (click)="toggle(event.id)"
                    >
                      <ng-icon
                        name="lucideChevronDown"
                        size="14"
                        aria-hidden="true"
                        class="transition-transform"
                        [class.rotate-180]="isOpen(event.id)"
                      />
                      {{ isOpen(event.id) ? 'Ocultar' : 'Ver' }} {{ event.children.length }}
                      {{ event.children.length === 1 ? 'recomendação' : 'recomendações' }}
                    </button>
                    @if (isOpen(event.id)) {
                      <ul class="mt-1 flex flex-col gap-1 border-l border-line pl-3">
                        @for (child of event.children; track child.id) {
                          <li class="flex flex-wrap items-center gap-2 text-sm text-ink">
                            {{ child.title }}
                            @if (child.badge) {
                              <span appBadge [tone]="child.tone ?? 'neutral'" size="xs">{{ child.badge }}</span>
                            }
                          </li>
                        }
                      </ul>
                    }
                  }
                </div>
              </li>
            }
          </ol>
        </section>
      }
    </div>
  `,
})
export class UiTimeline {
  readonly events = input.required<readonly TimelineEventVm[]>();

  private readonly open = signal<ReadonlySet<string>>(new Set());

  protected readonly groups = computed<DayGroup[]>(() => {
    const byDay = new Map<string, TimelineEventVm[]>();
    for (const e of this.events()) {
      // chave do dia em horário LOCAL (ICP BR) — não UTC, senão eventos à noite caem
      // no dia errado / "Hoje" desalinha.
      const day = localDay(new Date(e.at));
      const list = byDay.get(day) ?? byDay.set(day, []).get(day)!;
      list.push(e);
    }
    return [...byDay.entries()].map(([day, items]) => ({ day, label: this.dayLabel(day), items }));
  });

  protected isOpen(id: string): boolean {
    return this.open().has(id);
  }

  protected toggle(id: string): void {
    this.open.update((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  protected timeLabel(iso: string): string {
    return TIME_FMT.format(new Date(iso));
  }

  private dayLabel(day: string): string {
    if (day === localDay(new Date())) return "Hoje";
    return DAY_FMT.format(new Date(`${day}T00:00:00`));
  }
}

/** `YYYY-MM-DD` no fuso LOCAL (não UTC). */
function localDay(d: Date): string {
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
