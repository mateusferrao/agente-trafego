// Aba "Visão geral" (6a): faixa de KPIs AO VIVO (números crus do insights_snapshots,
// com as-of + "atualizar agora" + lazy on-view) + resultado da análise atual
// (grade/campanhas/recomendações, datado) + mini-surface acionável. Reusa o
// AccountContextStore (provido pelo shell) p/ run/recomendações/voto/silenciar.

import { ChangeDetectionStrategy, Component, DestroyRef, inject, signal } from "@angular/core";
import { NgIcon, provideIcons } from "@ng-icons/core";
import { lucideRefreshCw, lucideActivity } from "@ng-icons/lucide";
import { UiButton, UiEmptyState, UiSpinner, UiAnalysisProgress } from "@ui";
import { AGENT_NAME } from "@core/brand";
import { DashboardApiService } from "@core/api/dashboard-api.service";
import type { LiveMetricsOutput } from "@core/api/generated";
import { asOfLabel, money, windowLabel } from "../../shared/format";
import { AnalysisDetail } from "../analysis-detail/analysis-detail";
import { AgentActions } from "./agent-actions";
import { AccountContextStore } from "./account-context.store";

const DEFAULT_CURRENCY = "BRL";
const POLL_MS = 3000;
const MAX_POLLS = 6;

@Component({
  selector: "app-account-overview",
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [NgIcon, UiButton, UiEmptyState, UiSpinner, UiAnalysisProgress, AnalysisDetail, AgentActions],
  providers: [provideIcons({ lucideRefreshCw, lucideActivity })],
  template: `
    <div class="flex flex-col gap-6">
      <!-- Faixa de KPIs ao vivo (números crus; a avaliação do agente vem datada abaixo). -->
      @if (live(); as m) {
        @if (m.totals; as t) {
          <div class="flex flex-wrap items-center gap-x-6 gap-y-2 rounded-lg border border-line bg-panel p-4">
            <div class="flex flex-col">
              <span class="text-xs text-muted">Gasto ({{ windowLabel(m.window.since, m.window.until) }})</span>
              <span class="text-lg font-semibold text-ink">{{ money(t.spend, m.currency) }}</span>
            </div>
            @if (t.cpa !== undefined) {
              <div class="flex flex-col">
                <span class="text-xs text-muted">{{ t.cpaLabel ?? 'Custo por resultado' }}</span>
                <span class="text-lg font-semibold text-ink">{{ money(t.cpa, m.currency) }}</span>
              </div>
            }
            @if (t.roas !== undefined) {
              <div class="flex flex-col">
                <span class="text-xs text-muted">Retorno (ROAS)</span>
                <span class="text-lg font-semibold text-ink">{{ t.roas.toFixed(2) }}×</span>
              </div>
            }
            <div class="ml-auto flex items-center gap-3">
              <span class="text-xs" [class.text-muted]="!m.stale" [class.text-warning-strong]="m.stale">
                {{ asOfLabel(m.asOf, m.stale) }}
              </span>
              <button appButton variant="secondary" type="button" [disabled]="refreshing()" (click)="refresh()">
                <ng-icon name="lucideRefreshCw" size="14" aria-hidden="true" [class.animate-spin]="refreshing()" />
                {{ refreshing() ? 'Atualizando…' : 'Atualizar agora' }}
              </button>
            </div>
          </div>
        }
      }

      <!-- Resultado da análise (avaliação do agente — datada). -->
      @if (store.loading()) {
        <div class="flex items-center justify-center gap-3 rounded-lg border border-line bg-panel p-10 text-sm text-muted">
          <app-ui-spinner [size]="20" [stroke]="2" aria-hidden="true" />
          Carregando…
        </div>
      } @else if (store.analyzing()) {
        <div class="flex flex-col items-center justify-center gap-4 rounded-lg border border-line bg-panel p-10 text-center">
          <app-ui-analysis-progress [title]="analyzingTitle" [steps]="analysisSteps" />
          <span class="text-xs text-muted">Pode fechar esta tela. O resultado fica salvo aqui.</span>
        </div>
      } @else if (store.run() === null) {
        <app-ui-empty-state
          icon="lucideActivity"
          title="Rode a primeira análise"
          [description]="firstRunDescription"
        >
          <button appButton variant="primary" type="button" actions (click)="store.analyze()">Analisar agora</button>
        </app-ui-empty-state>
      } @else if (store.run()?.status === 'failed') {
        <div class="flex flex-col items-start gap-3 rounded-lg border border-line bg-panel p-6">
          <p class="text-sm text-ink">{{ store.run()?.summary ?? 'Não consegui concluir a análise agora.' }}</p>
          <button appButton variant="secondary" type="button" (click)="store.analyze()">Tentar de novo</button>
        </div>
      } @else {
        <app-analysis-detail
          [run]="store.run()"
          [campaigns]="store.campaigns()"
          [recommendations]="store.recommendations()"
          [currency]="store.account()?.currency ?? defaultCurrency"
          [votingId]="store.votingId()"
          [mutingId]="store.mutingId()"
          (vote)="store.vote($event)"
          (toggleMute)="store.toggleMuted($event)"
        />
        <app-agent-actions [accountId]="store.accountId" />
      }
    </div>
  `,
})
export class AccountOverview {
  protected readonly store = inject(AccountContextStore);
  private readonly api = inject(DashboardApiService);
  protected readonly defaultCurrency = DEFAULT_CURRENCY;
  // Copy de Marca (tom lúdico, voz própria, com aposto na 1ª menção do Roi).
  protected readonly analyzingTitle = `${AGENT_NAME} está analisando sua conta`;
  protected readonly analysisSteps = [
    "Puxando os números dos últimos dias",
    "Vendo onde o dinheiro foi",
    "Comparando com a sua meta",
    "Separando o que vale a pena mexer",
  ];
  protected readonly firstRunDescription = `O ${AGENT_NAME}, seu agente de tráfego, analisa suas campanhas e sugere melhorias sem mexer em nada na sua conta.`;
  // funções de formatação compartilhadas expostas ao template.
  protected readonly money = money;
  protected readonly asOfLabel = asOfLabel;
  protected readonly windowLabel = windowLabel;

  protected readonly live = signal<LiveMetricsOutput | null>(null);
  protected readonly refreshing = signal(false);
  private destroyed = false;

  constructor() {
    inject(DestroyRef).onDestroy(() => (this.destroyed = true));
    this.loadLive(true);
  }

  /** Carrega os KPIs ao vivo; `lazy` dispara refresh se o dado estiver velho. */
  private loadLive(lazy = false): void {
    this.api.liveMetrics(this.store.accountId).subscribe({
      next: (m) => {
        this.live.set(m);
        if (lazy && m.stale) this.refresh();
      },
      error: () => {},
    });
  }

  protected refresh(): void {
    if (this.refreshing()) return;
    this.refreshing.set(true);
    const before = this.live()?.asOf ?? null;
    this.api.refreshData(this.store.accountId).subscribe({
      next: () => this.pollLive(before, 0),
      error: () => this.refreshing.set(false),
    });
  }

  /** Poll bounded: espera o as-of mudar; timeout encerra sem travar (§UX). */
  private pollLive(before: string | null, attempt: number): void {
    if (this.destroyed) return;
    if (attempt >= MAX_POLLS) {
      this.refreshing.set(false);
      return;
    }
    setTimeout(() => {
      this.api.liveMetrics(this.store.accountId).subscribe({
        next: (m) => {
          if (m.asOf && m.asOf !== before) {
            this.live.set(m);
            this.refreshing.set(false);
          } else {
            this.pollLive(before, attempt + 1);
          }
        },
        error: () => this.refreshing.set(false),
      });
    }, POLL_MS);
  }

}
