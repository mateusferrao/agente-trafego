// Painel (home, 6a): visão gerencial cross-conta orientada a ação/resultado.
// 4 widgets: pendências + contas em atenção (triagem) + atividade recente (inclui
// chat) + panorama por conta (grade datada + KPIs ao vivo + as-of + refresh).
// Estados positivos/quietos (não "vazio que parece bug"). 0 contas → onboarding.

import { ChangeDetectionStrategy, Component, DestroyRef, inject, signal } from "@angular/core";
import { RouterLink } from "@angular/router";
import { NgIcon, provideIcons } from "@ng-icons/core";
import { heroCheckCircle, heroSparkles } from "@ng-icons/heroicons/outline";
import { UiBadge, UiButton, UiEmptyState, UiPageHeader, UiSpinner, type TimelineTone } from "@ui";
import { DashboardApiService } from "@core/api/dashboard-api.service";
import type { DashboardOutput } from "@core/api/generated";
import { actionTypeLabel } from "../../shared/action-format";
import { timeLabel } from "../../shared/format";
import { AccountPanoramaCard } from "../../shared/account-panorama-card";

type Card = DashboardOutput["panorama"][number];
type Activity = DashboardOutput["recentActivity"][number];
type Reason = Card["reasons"][number];

const LAZY_MAX = 8; // teto de refresh lazy no load (evita burst)
const RELOAD_MS = 5000;
/** Painel resume o panorama nas top-N por gasto; lista completa vive em Contas. */
const PANORAMA_TOP_N = 6;

const REASON_LABEL: Record<Reason, string> = {
  token_invalid: "token inválido",
  no_recent_run: "sem análise recente",
  bad_grade: "nota baixa",
  pending: "pendências",
};
const REASON_TONE: Record<Reason, TimelineTone> = {
  token_invalid: "danger",
  no_recent_run: "warning",
  bad_grade: "warning",
  pending: "info",
};

@Component({
  selector: "app-dashboard-page",
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, NgIcon, UiBadge, UiButton, UiEmptyState, UiPageHeader, UiSpinner, AccountPanoramaCard],
  providers: [provideIcons({ heroCheckCircle, heroSparkles })],
  template: `
    <div class="flex flex-col gap-6">
      <app-ui-page-header title="Painel" subtitle="Onde agir agora, em todas as suas contas" />

      @if (loading()) {
        <div class="flex items-center justify-center gap-3 rounded-lg border border-line bg-panel p-10 text-sm text-muted">
          <app-ui-spinner [size]="20" [stroke]="2" aria-hidden="true" /> Carregando…
        </div>
      } @else if (failed()) {
        <div class="flex flex-col items-start gap-3 rounded-lg border border-line bg-panel p-6">
          <p class="text-sm text-ink">Não consegui carregar o painel agora.</p>
          <button appButton variant="secondary" type="button" (click)="load()">Tentar de novo</button>
        </div>
      } @else if (data(); as d) {
        @if (d.panorama.length === 0) {
          <app-ui-empty-state
            icon="heroSparkles"
            title="Conecte sua primeira conta"
            description="Ligue uma conta Meta para o agente começar a analisar e sugerir melhorias."
          >
            <a appButton variant="primary" routerLink="/integrations" actions>Ir para Integrações</a>
          </app-ui-empty-state>
        } @else {
          <!-- Pendências -->
          <section class="rounded-lg border border-line bg-panel p-4">
            @if (d.pendingCount > 0) {
              <div class="flex flex-wrap items-center justify-between gap-3">
                <div class="flex items-center gap-2">
                  <span appBadge tone="warning" size="sm">{{ d.pendingCount }}</span>
                  <span class="text-sm text-ink">
                    {{ d.pendingCount === 1 ? 'ação aguarda seu OK' : 'ações aguardam seu OK' }}
                  </span>
                </div>
                <a appButton variant="secondary" routerLink="/approvals">Revisar pendências</a>
              </div>
            } @else {
              <p class="flex items-center gap-2 text-sm text-muted">
                <ng-icon name="heroCheckCircle" size="16" aria-hidden="true" class="text-success-strong" />
                Nenhuma pendência — tudo em dia.
              </p>
            }
          </section>

          <!-- Contas em atenção (triagem) -->
          @if (d.attention.length > 0) {
            <section class="flex flex-col gap-3">
              <h2 class="font-brand text-sm font-semibold text-ink">Precisam de atenção</h2>
              <div class="flex flex-col gap-2">
                @for (c of d.attention; track c.accountId) {
                  <a
                    [routerLink]="['/accounts', c.accountId]"
                    class="flex flex-wrap items-center gap-2 rounded-lg border border-line bg-panel p-3 transition hover:border-accent/40"
                  >
                    <span class="text-sm font-medium text-ink">{{ c.accountName }}</span>
                    @for (r of c.reasons; track r) {
                      <span appBadge [tone]="reasonTone(r)" size="xs">{{ reasonLabel(r) }}</span>
                    }
                  </a>
                }
              </div>
            </section>
          }

          <!-- Panorama por conta — resumo top-N por gasto; lista completa em Contas. -->
          <section class="flex flex-col gap-3">
            <div class="flex items-center justify-between gap-2">
              <h2 class="font-brand text-sm font-semibold text-ink">Suas contas</h2>
              @if (d.panorama.length > topN) {
                <a routerLink="/accounts" class="text-xs font-medium text-accent-strong hover:text-ink">
                  ver todas as {{ d.panorama.length }} →
                </a>
              }
            </div>
            <div class="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              @for (c of d.panorama.slice(0, topN); track c.accountId) {
                <app-account-panorama-card
                  [card]="c"
                  [refreshing]="refreshing().has(c.accountId)"
                  (refresh)="refreshAccount($event)"
                />
              }
            </div>
          </section>

          <!-- Atividade recente -->
          <section class="flex flex-col gap-3">
            <h2 class="font-brand text-sm font-semibold text-ink">Atividade recente do agente</h2>
            @if (d.recentActivity.length === 0) {
              <p class="rounded-lg border border-line bg-panel p-4 text-sm text-muted">Nenhuma ação recente.</p>
            } @else {
              <ul class="flex flex-col gap-2">
                @for (a of d.recentActivity; track a.id) {
                  <li class="flex flex-wrap items-center gap-2 rounded-lg border border-line bg-panel p-3 text-sm">
                    <span class="font-medium text-ink">{{ a.accountName }}</span>
                    <span class="text-muted">{{ activityLabel(a) }}</span>
                    @if (a.fromChat) {
                      <span appBadge tone="accent" size="xs">chat</span>
                    }
                    <span class="ml-auto text-xs text-muted">{{ timeLabel(a.at) }}</span>
                  </li>
                }
              </ul>
            }
          </section>
        }
      }
    </div>
  `,
})
export class DashboardPage {
  private readonly api = inject(DashboardApiService);

  protected readonly data = signal<DashboardOutput | null>(null);
  protected readonly loading = signal(true);
  protected readonly failed = signal(false);
  protected readonly refreshing = signal<ReadonlySet<string>>(new Set());
  private destroyed = false;

  constructor() {
    inject(DestroyRef).onDestroy(() => (this.destroyed = true));
    this.load(true);
  }

  protected load(lazy = false): void {
    this.loading.set(true);
    this.failed.set(false);
    this.api.dashboard().subscribe({
      next: (d) => {
        this.data.set(d);
        this.loading.set(false);
        if (lazy) this.lazyRefreshStale(d);
      },
      error: () => {
        this.failed.set(true);
        this.loading.set(false);
      },
    });
  }

  /** Lazy on-view: dispara sync-only (governado) das contas velhas, com teto; 1 reload. */
  private lazyRefreshStale(d: DashboardOutput): void {
    const stale = d.panorama.filter((c) => !c.agentPaused && c.stale).slice(0, LAZY_MAX);
    if (stale.length === 0) return;
    for (const c of stale) this.api.refreshData(c.accountId).subscribe({ error: () => {} });
    setTimeout(() => {
      if (!this.destroyed) this.load(false);
    }, RELOAD_MS);
  }

  protected refreshAccount(id: string): void {
    if (this.refreshing().has(id)) return;
    this.refreshing.update((s) => new Set(s).add(id));
    this.api.refreshData(id).subscribe({
      next: () =>
        setTimeout(() => {
          if (this.destroyed) return;
          this.api.dashboard().subscribe({
            next: (d) => this.data.set(d),
            error: () => {},
          });
          this.refreshing.update((s) => {
            const next = new Set(s);
            next.delete(id);
            return next;
          });
        }, RELOAD_MS),
      error: () =>
        this.refreshing.update((s) => {
          const next = new Set(s);
          next.delete(id);
          return next;
        }),
    });
  }

  protected readonly topN = PANORAMA_TOP_N;
  protected readonly timeLabel = timeLabel; // usado no feed de atividade

  protected reasonLabel(r: Reason): string {
    return REASON_LABEL[r];
  }
  protected reasonTone(r: Reason): TimelineTone {
    return REASON_TONE[r];
  }

  protected activityLabel(a: Activity): string {
    const action = a.type === "action_rolled_back" ? "reverteu" : actionTypeLabel(a.toolKey);
    return a.entityName ? `${action} · ${a.entityName}` : action;
  }
}
