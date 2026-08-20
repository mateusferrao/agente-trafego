import { ChangeDetectionStrategy, Component, DestroyRef, inject, signal } from '@angular/core';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { Subscription } from 'rxjs';
import { toast } from 'ngx-sonner';
import { provideIcons } from '@ng-icons/core';
import { heroSparkles } from '@ng-icons/heroicons/outline';
import { UiBadge, UiButton, UiEmptyState, UiPageHeader, UiSpinner } from '@ui';
import { AccountsApiService } from '@core/api/accounts-api.service';
import { AnalysisApiService } from '@core/api/analysis-api.service';
import type { AdAccountOutput, CampaignAnalysesOutput, LatestRunOutput, RunListOutput } from '@core/api/generated';
import { AnalysisDetail, GRADE_LABEL, GRADE_TONE, type GradeTone } from '../analysis-detail/analysis-detail';
import { AgentActions } from './agent-actions';

type Recommendation = LatestRunOutput['recommendations'][number];
type Campaign = CampaignAnalysesOutput['campaigns'][number];
type RunListItem = RunListOutput['items'][number];
type Grade = NonNullable<RunListItem['grade']>;

/** enquanto o run está nestes estados, seguimos consultando (polling). */
const IN_FLIGHT = new Set(['pending', 'running', 'waiting_approval']);
const POLL_INTERVAL_MS = 2500;

/** Notas disponíveis no filtro do histórico (multi-select). */
const GRADE_OPTIONS: readonly Grade[] = ['A', 'B', 'C', 'D'];

/** Uma opção do filtro de período (dias; null = tudo). */
interface PeriodOption {
  readonly days: number | null;
  readonly label: string;
}
const PERIOD_OPTIONS: readonly PeriodOption[] = [
  { days: 7, label: '7 dias' },
  { days: 30, label: '30 dias' },
  { days: 90, label: '90 dias' },
  { days: null, label: 'tudo' },
];
const DEFAULT_PERIOD_DAYS: number | null = 30;
const HISTORY_PAGE_SIZE = 20;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Gatilho do run → rótulo em linguagem de gente. */
const TRIGGER_LABEL: Record<string, string> = {
  cron: 'automática',
  on_demand: 'manual',
  conversation: 'conversa',
};

const DEFAULT_CURRENCY = 'BRL';
const DATETIME_LOCALE = 'pt-BR';

/**
 * Detalhe da conta (3a): "Analisar agora" → mostra as recomendações no site
 * (o WhatsApp entra na 3b). O resultado atual é renderizado por `app-analysis-detail`
 * (reusado no detalhe de um run do histórico). Abaixo, o histórico de análises
 * anteriores (filtros por nota + período). Segue docs/DESIGN.md.
 */
@Component({
  selector: 'app-account-detail-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, UiBadge, UiButton, UiEmptyState, UiPageHeader, UiSpinner, AnalysisDetail, AgentActions],
  providers: [provideIcons({ heroSparkles })],
  template: `
    <div class="flex flex-col gap-8">
      <div class="flex flex-col gap-1">
        <a routerLink="/accounts" class="text-xs text-muted hover:text-ink">← Contas</a>
        <app-ui-page-header [title]="accountName()" [subtitle]="accountSubtitle()">
          <button
            appButton
            variant="primary"
            type="button"
            actions
            [disabled]="analyzing()"
            (click)="analyze()"
          >
            {{ analyzing() ? 'Analisando…' : 'Analisar agora' }}
          </button>
        </app-ui-page-header>
      </div>

      <!-- Token da conexão expirou → análises pausadas; reconectar é em Integrações. -->
      @if (account()?.tokenStatus === 'invalid') {
        <div class="rounded-lg border border-line bg-panel p-4 text-sm text-danger-strong">
          O token da integração com a Meta expirou, então as análises desta conta estão paradas.
          <a routerLink="/integrations" class="underline">Reconecte em Integrações</a> para retomar.
        </div>
      }

      <!-- Resultado da análise em primeiro (é o que o usuário mais quer ver) -->
      @if (loading()) {
        <div class="flex items-center justify-center gap-3 rounded-lg border border-line bg-panel p-10 text-sm text-muted">
          <app-ui-spinner [size]="20" [stroke]="2" aria-hidden="true" />
          Carregando…
        </div>
      } @else if (analyzing()) {
        <div class="flex flex-col items-center justify-center gap-2 rounded-lg border border-line bg-panel p-10 text-center text-sm text-muted">
          <app-ui-spinner [size]="20" [stroke]="2" aria-hidden="true" />
          <span>Analisando sua conta… isso pode levar alguns minutos.</span>
          <span class="text-xs">Pode fechar esta tela — o resultado fica salvo aqui e o agente te avisa no WhatsApp quando terminar.</span>
        </div>
      } @else if (run() === null) {
        <app-ui-empty-state
          icon="heroSparkles"
          title="Rode a primeira análise"
          description="O agente analisa suas campanhas e sugere melhorias — sem alterar nada na sua conta."
        >
          <button appButton variant="primary" type="button" actions (click)="analyze()">Analisar agora</button>
        </app-ui-empty-state>
      } @else if (run()?.status === 'failed') {
        <div class="flex flex-col items-start gap-3 rounded-lg border border-line bg-panel p-6">
          <p class="text-sm text-ink">{{ run()?.summary ?? 'Não consegui concluir a análise agora.' }}</p>
          <button appButton variant="secondary" type="button" (click)="analyze()">Tentar de novo</button>
        </div>
      } @else {
        <app-analysis-detail
          [run]="run()"
          [campaigns]="campaigns()"
          [recommendations]="recommendations()"
          [currency]="account()?.currency ?? defaultCurrency"
          [votingId]="votingId()"
          [mutingId]="mutingId()"
          (vote)="vote($event)"
          (toggleMute)="toggleMuted($event)"
        />

        <app-agent-actions [accountId]="accountId" />
      }

      <!-- Histórico: análises anteriores desta conta (filtros por nota + período) -->
      <section class="flex flex-col gap-4">
        <div class="flex flex-col gap-1">
          <h2 class="font-brand text-sm font-semibold text-ink">Análises anteriores</h2>
          <p class="text-xs text-muted">Reveja o que o agente encontrou em análises passadas.</p>
        </div>

        <div class="flex flex-col gap-3">
          <div class="flex flex-wrap items-center gap-2" role="group" aria-label="Filtrar por nota">
            <span class="text-xs text-muted">Nota</span>
            @for (g of gradeOptions; track g) {
              <button
                type="button"
                [attr.aria-pressed]="gradeFilters().includes(g)"
                (click)="toggleGrade(g)"
                class="rounded-md border px-3 py-1 text-xs font-medium transition hover:border-accent/40"
                [class.border-accent]="gradeFilters().includes(g)"
                [class.bg-accent-soft]="gradeFilters().includes(g)"
                [class.text-ink]="gradeFilters().includes(g)"
                [class.border-line]="!gradeFilters().includes(g)"
                [class.text-muted]="!gradeFilters().includes(g)"
              >
                {{ g }}
              </button>
            }
          </div>
          <div class="flex flex-wrap items-center gap-2" role="radiogroup" aria-label="Filtrar por período">
            <span class="text-xs text-muted">Período</span>
            @for (p of periodOptions; track p.label) {
              <button
                type="button"
                role="radio"
                [attr.aria-checked]="periodDays() === p.days"
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

        @if (loadingHistory() && history().length === 0) {
          <div class="flex items-center gap-3 rounded-lg border border-line bg-panel p-4 text-sm text-muted">
            <app-ui-spinner [size]="16" [stroke]="2" aria-hidden="true" />
            Carregando…
          </div>
        } @else if (history().length === 0) {
          <p class="rounded-lg border border-line bg-panel p-4 text-sm text-muted">Nenhuma análise anterior ainda.</p>
        } @else {
          <div class="flex flex-col gap-2">
            @for (item of history(); track item.id) {
              <a
                [routerLink]="['/accounts', accountId, 'runs', item.id]"
                class="flex flex-col gap-2 rounded-lg border border-line bg-panel p-4 transition hover:border-accent/40"
              >
                <div class="flex flex-wrap items-center justify-between gap-2">
                  <span class="text-xs text-muted">{{ formatDateTime(item.createdAt) }}</span>
                  <div class="flex flex-wrap items-center gap-2">
                    @if (item.grade) {
                      <span appBadge [tone]="historyGradeTone(item.grade)" size="sm">
                        Nota {{ item.grade }} · {{ historyGradeLabel(item.grade) }}
                      </span>
                    } @else {
                      <span appBadge size="sm">sem nota</span>
                    }
                    @if (item.partial) {
                      <span appBadge tone="warning" size="sm">parcial</span>
                    }
                    <span class="text-xs text-muted">{{ triggerLabel(item.trigger) }}</span>
                  </div>
                </div>
                @if (item.headline) {
                  <p class="truncate text-sm text-ink">{{ item.headline }}</p>
                }
                <span class="text-xs text-muted">
                  {{ item.recommendationCount }} {{ item.recommendationCount === 1 ? 'recomendação' : 'recomendações' }}
                </span>
              </a>
            }
          </div>
          @if (historyHasMore()) {
            <button appButton variant="secondary" type="button" [disabled]="loadingHistory()" (click)="loadMoreHistory()">
              {{ loadingHistory() ? 'Carregando…' : 'Carregar mais' }}
            </button>
          }
        }
      </section>

      <!-- Controles do agente: flutua no rodapé (config completa em tela própria + freio) -->
      <div class="sticky bottom-0 z-10 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-line bg-panel p-5 shadow-card">
        <div class="flex flex-col gap-1">
          <h2 class="font-brand text-sm font-semibold text-ink">Agente</h2>
          <p class="text-xs text-muted">
            {{ paused() ? 'Análises automáticas pausadas — o agente não analisa sozinho nem te avisa no WhatsApp.' : 'Análises automáticas ativas — o agente analisa no ritmo configurado e te avisa no WhatsApp.' }}
          </p>
        </div>
        <div class="flex items-center gap-3">
          <a appButton variant="secondary" [routerLink]="['/accounts', accountId, 'agente']">Configurar agente</a>
          <button appButton variant="secondary" type="button" [disabled]="pausing()" (click)="togglePaused()">
            {{ pausing() ? 'Salvando…' : paused() ? 'Retomar' : 'Pausar' }}
          </button>
        </div>
      </div>
    </div>
  `,
})
export class AccountDetailPage {
  private readonly route = inject(ActivatedRoute);
  private readonly accountsApi = inject(AccountsApiService);
  private readonly analysisApi = inject(AnalysisApiService);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly accountId = this.route.snapshot.paramMap.get('id') ?? '';
  private destroyed = false;

  protected readonly defaultCurrency = DEFAULT_CURRENCY;
  protected readonly gradeOptions = GRADE_OPTIONS;
  protected readonly periodOptions = PERIOD_OPTIONS;

  protected readonly account = signal<AdAccountOutput | null>(null);
  protected readonly run = signal<LatestRunOutput['run']>(null);
  protected readonly recommendations = signal<Recommendation[]>([]);
  protected readonly loading = signal(true);
  protected readonly analyzing = signal(false);

  protected readonly paused = signal(false);
  protected readonly pausing = signal(false);
  protected readonly votingId = signal<string | null>(null);
  protected readonly campaigns = signal<Campaign[]>([]);
  protected readonly mutingId = signal<string | null>(null);

  // histórico de análises anteriores
  protected readonly history = signal<RunListItem[]>([]);
  protected readonly historyHasMore = signal(false);
  protected readonly loadingHistory = signal(false);
  protected readonly gradeFilters = signal<Grade[]>([]);
  protected readonly periodDays = signal<number | null>(DEFAULT_PERIOD_DAYS);
  private historyOffset = 0;
  private historySub?: Subscription;

  constructor() {
    this.destroyRef.onDestroy(() => {
      this.destroyed = true;
    });
    this.loadAll();
    this.loadHistory();
  }

  protected accountName(): string {
    return this.account()?.name ?? this.account()?.adAccountId ?? 'Conta';
  }
  protected accountSubtitle(): string {
    const acc = this.account();
    if (!acc) return 'Análise da conta';
    return `Conta ${acc.adAccountId}${acc.currency ? ` · ${acc.currency}` : ''}`;
  }

  /** Silencia/reativa uma campanha (opt-out da análise). Reflete a lista do backend. */
  protected toggleMuted(c: Campaign): void {
    this.mutingId.set(c.externalId);
    const req = c.muted
      ? this.analysisApi.unmuteCampaign(this.accountId, c.externalId)
      : this.analysisApi.muteCampaign(this.accountId, c.externalId);
    req.subscribe({
      next: (out) => {
        const mutedSet = new Set(out.campaignIds);
        this.campaigns.update((list) =>
          list.map((x) => ({ ...x, muted: mutedSet.has(x.externalId) })),
        );
        this.mutingId.set(null);
        toast.success(c.muted ? 'Campanha reativada' : 'Campanha silenciada');
      },
      // erro amigável já vem do interceptor global.
      error: () => this.mutingId.set(null),
    });
  }

  protected vote(event: { id: string; vote: 'up' | 'down' }): void {
    const rec = this.recommendations().find((r) => r.id === event.id);
    if (rec?.vote === event.vote) return; // já votado assim
    this.votingId.set(event.id);
    this.analysisApi.sendFeedback(event.id, event.vote).subscribe({
      next: () => {
        // reflete o voto localmente (o backend já registrou + memória em 👎).
        this.recommendations.update((list) =>
          list.map((r) => (r.id === event.id ? { ...r, vote: event.vote } : r)),
        );
        this.votingId.set(null);
      },
      // erro amigável já vem do interceptor global; o botão volta a habilitar.
      error: () => this.votingId.set(null),
    });
  }

  protected togglePaused(): void {
    const next = !this.paused();
    this.pausing.set(true);
    this.analysisApi.setPaused(this.accountId, next).subscribe({
      next: (agent) => {
        this.paused.set(agent.paused);
        this.pausing.set(false);
        toast.success(agent.paused ? 'Análises pausadas' : 'Análises retomadas');
      },
      // erro amigável já vem do interceptor global (§8 kill-switch: nunca silencioso).
      error: () => this.pausing.set(false),
    });
  }

  protected analyze(): void {
    this.analyzing.set(true);
    this.analysisApi.triggerRun(this.accountId).subscribe({
      next: () => this.poll(),
      // erro amigável já vem do interceptor global.
      error: () => this.analyzing.set(false),
    });
  }

  // ── histórico ─────────────────────────────────────────────────────────────

  protected toggleGrade(g: Grade): void {
    this.gradeFilters.update((cur) => (cur.includes(g) ? cur.filter((x) => x !== g) : [...cur, g]));
    this.loadHistory();
  }

  protected setPeriod(days: number | null): void {
    if (this.periodDays() === days) return;
    this.periodDays.set(days);
    this.loadHistory();
  }

  protected loadMoreHistory(): void {
    if (this.loadingHistory()) return; // evita clique duplo enquanto carrega
    this.historyOffset += HISTORY_PAGE_SIZE;
    this.loadHistory(true);
  }

  protected triggerLabel(trigger: RunListItem['trigger']): string {
    return TRIGGER_LABEL[trigger] ?? trigger;
  }
  protected historyGradeTone(grade: Grade): GradeTone {
    return GRADE_TONE[grade];
  }
  protected historyGradeLabel(grade: Grade): string {
    return GRADE_LABEL[grade];
  }
  protected formatDateTime(iso: string): string {
    return formatDateTime(iso);
  }

  /** Carrega o histórico (aplica filtros). `append` acrescenta a próxima página. */
  private loadHistory(append = false): void {
    if (!append) this.historyOffset = 0;
    // corrida: cancela a request anterior em voo → a última (filtro atual) sempre vence.
    this.historySub?.unsubscribe();
    this.loadingHistory.set(true);
    const period = this.periodDays();
    const since = period === null ? undefined : new Date(Date.now() - period * DAY_MS).toISOString();
    const grades = this.gradeFilters();
    this.historySub = this.analysisApi
      .listRuns(this.accountId, {
        grades: grades.length > 0 ? grades : undefined,
        since,
        limit: HISTORY_PAGE_SIZE,
        offset: this.historyOffset,
      })
      .subscribe({
        next: (out) => {
          this.history.update((list) => (append ? [...list, ...out.items] : out.items));
          this.historyHasMore.set(out.hasMore);
          this.loadingHistory.set(false);
        },
        // silencioso (secundário): degrada sem toast.
        error: () => {
          // reverte o offset avançado no "carregar mais" p/ não pular uma página.
          if (append) this.historyOffset -= HISTORY_PAGE_SIZE;
          else this.history.set([]);
          this.loadingHistory.set(false);
        },
      });
  }

  private loadAll(): void {
    this.accountsApi.list().subscribe({
      next: (rows) => this.account.set(rows.find((r) => r.id === this.accountId) ?? null),
      error: () => this.account.set(null),
    });
    this.analysisApi.getAgent(this.accountId).subscribe({
      next: (agent) => this.paused.set(agent.paused),
      // estado de pausa é secundário; se não carregar, assume ativo (default). Sem travar a tela.
      error: () => {},
    });
    this.analysisApi.latestRun(this.accountId).subscribe({
      next: (latest) => {
        this.applyLatest(latest);
        this.loading.set(false);
        // um run já em andamento (ex: aberto em outra aba) → retoma o polling.
        if (latest.run && IN_FLIGHT.has(latest.run.status)) {
          this.analyzing.set(true);
          this.poll();
        } else if (latest.run) {
          this.loadCampaigns();
        }
      },
      error: () => this.loading.set(false),
    });
  }

  /** Recorte por campanha do resultado atual (cartões). Falha silenciosa (secundário). */
  private loadCampaigns(): void {
    this.analysisApi.campaignAnalyses(this.accountId).subscribe({
      next: (out) => this.campaigns.set(out.campaigns),
      error: () => this.campaigns.set([]),
    });
  }

  private poll(): void {
    if (this.destroyed) return;
    this.analysisApi.latestRun(this.accountId).subscribe({
      next: (latest) => {
        this.applyLatest(latest);
        if (latest.run && IN_FLIGHT.has(latest.run.status)) {
          setTimeout(() => this.poll(), POLL_INTERVAL_MS);
        } else {
          this.analyzing.set(false);
          if (latest.run) {
            this.loadCampaigns();
            this.loadHistory(); // um run recém-concluído entra no histórico.
          }
        }
      },
      error: () => this.analyzing.set(false),
    });
  }

  private applyLatest(latest: LatestRunOutput): void {
    this.run.set(latest.run);
    this.recommendations.set(latest.recommendations);
  }
}

function formatDateTime(iso: string): string {
  try {
    return new Intl.DateTimeFormat(DATETIME_LOCALE, { dateStyle: 'short', timeStyle: 'short' }).format(
      new Date(iso),
    );
  } catch {
    return iso;
  }
}
