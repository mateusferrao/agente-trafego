// Aba "Timeline" (6a): feed de auditoria da conta (análises + ações incl. chat +
// aprovações + erros). Busca a API, mapeia o evento tipado → view-model do
// ui-timeline (presentacional). Filtros por grupo + período + "carregar mais".

import { ChangeDetectionStrategy, Component, inject, signal } from "@angular/core";
import { ActivatedRoute } from "@angular/router";
import { UiButton, UiSpinner, UiTimeline, type TimelineEventVm } from "@ui";
import { DashboardApiService } from "@core/api/dashboard-api.service";
import type { TimelineOutput } from "@core/api/generated";
import { actionTypeLabel } from "../../shared/action-format";
import { gradeTone } from "../../shared/format";

type ApiEvent = TimelineOutput["items"][number];

/** Grupos de filtro → tipos de evento da API. */
const GROUPS: readonly { key: string; label: string; types: readonly string[] }[] = [
  { key: "analises", label: "Análises", types: ["analysis_completed", "error"] },
  { key: "acoes", label: "Ações", types: ["action_applied", "action_rolled_back"] },
  { key: "aprovacoes", label: "Aprovações", types: ["approval_requested", "approval_approved", "approval_rejected", "approval_expired"] },
];
const PERIODS: readonly { days: number | null; label: string }[] = [
  { days: 7, label: "7 dias" },
  { days: 30, label: "30 dias" },
  { days: 90, label: "90 dias" },
  { days: null, label: "tudo" },
];
const PAGE = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

@Component({
  selector: "app-account-timeline",
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [UiButton, UiSpinner, UiTimeline],
  template: `
    <div class="flex flex-col gap-4">
      <div class="flex flex-col gap-3">
        <div class="flex flex-wrap items-center gap-2" role="group" aria-label="Filtrar por tipo">
          <span class="text-xs text-muted">Tipo</span>
          @for (g of groups; track g.key) {
            <button
              type="button"
              [attr.aria-pressed]="selected().includes(g.key)"
              (click)="toggleGroup(g.key)"
              class="rounded-md border px-3 py-1 text-xs font-medium transition hover:border-accent/40"
              [class.border-accent]="selected().includes(g.key)"
              [class.bg-accent-soft]="selected().includes(g.key)"
              [class.text-ink]="selected().includes(g.key)"
              [class.border-line]="!selected().includes(g.key)"
              [class.text-muted]="!selected().includes(g.key)"
            >
              {{ g.label }}
            </button>
          }
        </div>
        <div class="flex flex-wrap items-center gap-2" role="group" aria-label="Filtrar por período">
          <span class="text-xs text-muted">Período</span>
          @for (p of periods; track p.label) {
            <button
              type="button"
              [attr.aria-pressed]="periodDays() === p.days"
              (click)="setPeriod(p.days)"
              class="rounded-md border px-3 py-1 text-xs font-medium transition hover:border-accent/40"
              [class.border-accent]="periodDays() === p.days"
              [class.bg-accent-soft]="periodDays() === p.days"
              [class.text-ink]="periodDays() === p.days"
              [class.border-line]="periodDays() !== p.days"
              [class.text-muted]="periodDays() !== p.days"
            >
              {{ p.label }}
            </button>
          }
        </div>
      </div>

      @if (loading() && events().length === 0) {
        <div class="flex items-center gap-3 rounded-lg border border-line bg-panel p-4 text-sm text-muted">
          <app-ui-spinner [size]="16" [stroke]="2" aria-hidden="true" />
          Carregando…
        </div>
      } @else if (failed()) {
        <div class="flex flex-col items-start gap-3 rounded-lg border border-line bg-panel p-4">
          <p class="text-sm text-ink">Não consegui carregar a linha do tempo agora.</p>
          <button appButton variant="secondary" type="button" (click)="load()">Tentar de novo</button>
        </div>
      } @else if (events().length === 0) {
        <p class="rounded-lg border border-line bg-panel p-4 text-sm text-muted">
          Nada por aqui ainda. As análises, ações e aprovações desta conta vão aparecer nesta linha do tempo.
        </p>
      } @else {
        <app-ui-timeline [events]="events()" />
        @if (hasMore()) {
          <button appButton variant="secondary" type="button" [disabled]="loading()" (click)="loadMore()">
            {{ loading() ? 'Carregando…' : 'Carregar mais' }}
          </button>
        }
      }
    </div>
  `,
})
export class AccountTimeline {
  private readonly api = inject(DashboardApiService);
  private readonly accountId = inject(ActivatedRoute).snapshot.paramMap.get("id") ?? "";

  protected readonly groups = GROUPS;
  protected readonly periods = PERIODS;
  protected readonly selected = signal<string[]>([]);
  protected readonly periodDays = signal<number | null>(30);
  protected readonly events = signal<TimelineEventVm[]>([]);
  protected readonly loading = signal(true);
  protected readonly failed = signal(false);
  protected readonly hasMore = signal(false);
  private offset = 0;

  constructor() {
    this.load();
  }

  protected toggleGroup(key: string): void {
    this.selected.update((cur) => (cur.includes(key) ? cur.filter((k) => k !== key) : [...cur, key]));
    this.load();
  }
  protected setPeriod(days: number | null): void {
    if (this.periodDays() === days) return;
    this.periodDays.set(days);
    this.load();
  }
  protected loadMore(): void {
    if (this.loading()) return;
    this.offset += PAGE;
    this.load(true);
  }

  protected load(append = false): void {
    if (!append) {
      this.offset = 0;
      this.failed.set(false);
    }
    this.loading.set(true);
    const types = this.selected().flatMap((k) => GROUPS.find((g) => g.key === k)?.types ?? []);
    const period = this.periodDays();
    const since = period === null ? undefined : new Date(Date.now() - period * DAY_MS).toISOString();
    this.api
      .timeline(this.accountId, { types, since, limit: PAGE, offset: this.offset })
      .subscribe({
        next: (out) => {
          const vms = out.items.map(toVm);
          this.events.update((list) => (append ? [...list, ...vms] : vms));
          this.hasMore.set(out.hasMore);
          this.loading.set(false);
        },
        error: () => {
          // append: mantém o que já tem; carga inicial: mostra estado de erro (retry).
          if (append) this.offset -= PAGE;
          else {
            this.events.set([]);
            this.failed.set(true);
          }
          this.loading.set(false);
        },
      });
  }
}

/** Evento tipado da API → view-model do ui-timeline. */
function toVm(e: ApiEvent): TimelineEventVm {
  switch (e.type) {
    case "analysis_completed":
      return {
        id: e.id,
        at: e.at,
        icon: "heroSparkles",
        title: "Análise concluída",
        detail: e.headline,
        badge: e.grade ? `Nota ${e.grade}` : null,
        tone: gradeTone(e.grade),
        children: e.recommendations.map((r) => ({
          id: r.id,
          title: r.title,
          badge: r.riskLevel,
          tone: "neutral" as const,
        })),
      };
    case "error":
      return { id: e.id, at: e.at, icon: "heroExclamationTriangle", title: "Análise não concluída", detail: e.message, badge: "erro", tone: "danger" };
    case "action_applied":
      return {
        id: e.id,
        at: e.at,
        icon: "heroBolt",
        title: `${actionTypeLabel(e.toolKey)}${e.entityName ? ` · ${e.entityName}` : ""}`,
        detail: e.fromChat ? "via WhatsApp" : null,
        badge: e.simulated ? "simulado" : e.fromChat ? "chat" : null,
        tone: e.simulated ? "neutral" : "accent",
      };
    case "action_rolled_back":
      return { id: e.id, at: e.at, icon: "heroArrowUturnLeft", title: `Ação revertida${e.entityName ? ` · ${e.entityName}` : ""}`, badge: "revertido", tone: "neutral" };
    case "approval_requested":
      return { id: e.id, at: e.at, icon: "heroClock", title: `Aprovação pedida · ${actionTypeLabel(e.actionType)}${e.entityName ? ` · ${e.entityName}` : ""}`, badge: "aguardando", tone: "warning" };
    case "approval_approved":
      return { id: e.id, at: e.at, icon: "heroCheckCircle", title: `Aprovada · ${actionTypeLabel(e.actionType)}${e.entityName ? ` · ${e.entityName}` : ""}`, badge: "aprovada", tone: "success" };
    case "approval_rejected":
      return { id: e.id, at: e.at, icon: "heroXCircle", title: `Rejeitada · ${actionTypeLabel(e.actionType)}${e.entityName ? ` · ${e.entityName}` : ""}`, badge: "rejeitada", tone: "neutral" };
    case "approval_expired":
      return { id: e.id, at: e.at, icon: "heroClock", title: `Expirada · ${actionTypeLabel(e.actionType)}${e.entityName ? ` · ${e.entityName}` : ""}`, badge: "expirada", tone: "neutral" };
    default:
      return { id: (e as { id: string }).id, at: (e as { at: string }).at, icon: "heroSparkles", title: "Evento", tone: "neutral" };
  }
}
