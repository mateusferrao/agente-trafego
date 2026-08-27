// Aba "Visão geral" (6a): faixa de KPIs AO VIVO (números crus do insights_snapshots,
// com as-of + "atualizar agora" + lazy on-view) + resultado da análise atual
// (grade/campanhas/recomendações, datado) + mini-surface acionável. Reusa o
// AccountContextStore (provido pelo shell) p/ run/recomendações/voto/silenciar.

import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, signal } from "@angular/core";
import { NgIcon, provideIcons } from "@ng-icons/core";
import { lucideRefreshCw } from "@ng-icons/lucide";
import { UiButton, UiEmptyState, UiSpinner, UiAnalysisProgress, UiSkeleton } from "@ui";
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
  imports: [NgIcon, UiButton, UiEmptyState, UiSpinner, UiAnalysisProgress, UiSkeleton, AnalysisDetail, AgentActions],
  providers: [provideIcons({ lucideRefreshCw })],
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
        <div class="flex flex-col gap-4">
          <div class="ui-panel-card--brand ui-accent-peach flex flex-col items-center gap-3 text-center">
            <app-ui-analysis-progress [title]="analyzingTitle" [steps]="analysisSteps" />
            <span class="text-xs text-muted">{{ analyzingReassurance }}</span>
          </div>
          <!-- Esqueleto do que vai surgir (veredito + cards) — trabalho real + preview. -->
          <div class="ui-panel-card--brand flex flex-col gap-3">
            <app-ui-skeleton width="40%" height="0.75rem" />
            <app-ui-skeleton width="80%" height="1.4rem" />
            <div class="flex gap-6">
              <app-ui-skeleton width="4rem" height="1.6rem" />
              <app-ui-skeleton width="4rem" height="1.6rem" />
              <app-ui-skeleton width="4rem" height="1.6rem" />
            </div>
          </div>
          @for (i of skeletonRows; track i) {
            <div class="flex flex-col gap-3 rounded-lg border border-line border-l-4 border-l-line bg-panel p-4">
              <app-ui-skeleton width="30%" height="0.7rem" />
              <app-ui-skeleton width="60%" height="1.1rem" />
              <div class="flex gap-4">
                <app-ui-skeleton width="3rem" height="1rem" />
                <app-ui-skeleton width="3rem" height="1rem" />
              </div>
            </div>
          }
        </div>
      } @else if (showEmptyState()) {
        <app-ui-empty-state
          brand
          [title]="emptyTitle()"
          [description]="emptyDescription()"
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
          [scalingId]="store.scalingId()"
          [canScale]="store.canScale()"
          [scaleAsk]="store.scaleAskView()"
          (vote)="store.vote($event)"
          (toggleMute)="store.toggleMuted($event)"
          (scale)="store.scaleWinner($event)"
          (scaleChoose)="store.scaleChoose($event)"
          (scaleCancel)="store.scaleCancel()"
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
  // Copy de Marca (tom lúdico, voz própria, com aposto na 1ª menção do Roy).
  protected readonly analyzingTitle = `${AGENT_NAME} está analisando sua conta`;
  protected readonly analysisSteps = [
    "Puxando os números dos últimos dias",
    "Vendo onde o dinheiro foi",
    "Comparando com a sua meta",
    "Separando o que vale a pena mexer",
  ];
  protected readonly firstRunDescription = `O ${AGENT_NAME}, seu agente de tráfego, analisa suas campanhas e sugere melhorias sem mexer em nada na sua conta.`;
  // Run concluído mas sem nada a mostrar (conta sem campanhas/movimento pra avaliar).
  protected readonly emptyResultDescription = `O ${AGENT_NAME} olhou a conta e não achou campanhas com movimento pra avaliar. Assim que houver anúncios rodando ele entra em ação. Se quiser, rode uma análise agora pra dar uma olhada.`;
  protected readonly analyzingReassurance = `Pode fechar esta tela. O resultado fica salvo aqui e, se o seu WhatsApp estiver conectado, o ${AGENT_NAME} te avisa por lá.`;
  protected readonly skeletonRows = [1, 2];
  // funções de formatação compartilhadas expostas ao template.
  protected readonly money = money;
  protected readonly asOfLabel = asOfLabel;
  protected readonly windowLabel = windowLabel;

  protected readonly live = signal<LiveMetricsOutput | null>(null);
  protected readonly refreshing = signal(false);
  private destroyed = false;

  /**
   * Run concluído mas sem nada a exibir — a conta não tem métricas/campanhas/recomendações
   * pra mostrar. Ex.: conta sem campanhas com movimento. Evita a casca vazia; cai no mesmo
   * empty-state acionável. Casa com o `hasResults` do analysis-detail INVERTIDO por conta de
   * um invariante daquele componente: `verdictStats` sempre tem ≥1 item ("Gasto") quando
   * `metrics` existe — então `!metrics && sem campanhas && sem recomendações` ⇒ hasResults=false.
   * Se aquele invariante mudar, alinhar as duas condições (idealmente extrair um predicado único).
   * Estados in-flight (pending/running/waiting_approval) não chegam aqui — o ramo `analyzing()` os trata antes.
   */
  private readonly runEmptyResult = computed<boolean>(() => {
    const run = this.store.run();
    if (!run || run.status === "failed") return false;
    return !run.metrics && this.store.campaigns().length === 0 && this.store.recommendations().length === 0;
  });
  protected readonly showEmptyState = computed<boolean>(
    () => this.store.run() === null || this.runEmptyResult(),
  );
  protected readonly emptyTitle = computed<string>(() =>
    this.runEmptyResult() ? "Nada para analisar ainda" : "Rode a primeira análise",
  );
  protected readonly emptyDescription = computed<string>(() =>
    this.runEmptyResult() ? this.emptyResultDescription : this.firstRunDescription,
  );

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
