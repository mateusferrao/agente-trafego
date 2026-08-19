import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { toast } from 'ngx-sonner';
import { provideIcons } from '@ng-icons/core';
import { heroSparkles } from '@ng-icons/heroicons/outline';
import { UiBadge, UiButton, UiEmptyState, UiPageHeader, UiSpinner } from '@ui';
import { AccountsApiService } from '@core/api/accounts-api.service';
import { AnalysisApiService } from '@core/api/analysis-api.service';
import type { AdAccountOutput, CampaignAnalysesOutput, LatestRunOutput } from '@core/api/generated';

type Recommendation = LatestRunOutput['recommendations'][number];
type Campaign = CampaignAnalysesOutput['campaigns'][number];
type RunMetrics = NonNullable<NonNullable<LatestRunOutput['run']>['metrics']>;
type Scorecard = NonNullable<RunMetrics['scorecard']>;
type RiskTone = 'neutral' | 'warning' | 'danger';
type GradeTone = 'success' | 'info' | 'warning' | 'danger';

/** item da faixa de KPIs / taxas (rótulo humano + valor já formatado). */
interface Stat {
  readonly label: string;
  readonly value: string;
}

const RISK_TONE: Record<Recommendation['riskLevel'], RiskTone> = {
  low: 'neutral',
  medium: 'warning',
  high: 'danger',
};
const RISK_LABEL: Record<Recommendation['riskLevel'], string> = {
  low: 'risco baixo',
  medium: 'risco médio',
  high: 'risco alto',
};
const ACTION_LABEL: Record<string, string> = {
  pause_entity: 'Pausar',
  resume_entity: 'Reativar',
  adjust_budget: 'Ajustar orçamento',
  set_status: 'Mudar status',
};
const LEVEL_LABEL: Record<string, string> = {
  account: 'conta',
  campaign: 'campanha',
  adset: 'conjunto',
  ad: 'anúncio',
};

/** enquanto o run está nestes estados, seguimos consultando (polling). */
const IN_FLIGHT = new Set(['pending', 'running', 'waiting_approval']);
const POLL_INTERVAL_MS = 2500;
/** aplicação de ações chega na fase de escrita (Fatia 5) — texto único (decisão 13). */
const APPLICABILITY_NOTE = 'Sugestão — a aplicação automática chega em breve.';

/** Nota da conta (scorecard) → tom+texto (nunca só cor — docs/DESIGN.md). */
const GRADE_TONE: Record<Scorecard['grade'], GradeTone> = {
  A: 'success',
  B: 'info',
  C: 'warning',
  D: 'danger',
};
const GRADE_LABEL: Record<Scorecard['grade'], string> = {
  A: 'ótimo',
  B: 'bom',
  C: 'atenção',
  D: 'crítico',
};
/** "Maior vazamento" em linguagem de gente (sem jargão). */
const LEAK_LABEL: Record<Scorecard['biggestLeak'], string> = {
  consciencia: 'alcançar as pessoas certas',
  engajamento: 'engajamento com os anúncios',
  conversao: 'transformar cliques em vendas',
  receita: 'retorno sobre o investimento',
};

/**
 * Detalhe da conta (3a): "Analisar agora" → mostra as recomendações no site
 * (o WhatsApp entra na 3b). Meta mínima (CPA/ROAS) editável — o resto da config
 * é a Fatia 4. Segue docs/DESIGN.md (status=tom+texto, erro amigável+próximo passo).
 */
@Component({
  selector: 'app-account-detail-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, UiBadge, UiButton, UiEmptyState, UiPageHeader, UiSpinner],
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
        <section class="flex flex-col gap-4">
          @if (run()?.summary) {
            <p class="rounded-lg border border-line bg-panel p-5 text-sm text-ink">{{ run()?.summary }}</p>
          }
          <!-- Sem resultados (ex: conta sem gasto): o resumo acima já basta; a
               ressalva "parcial" e o "nenhuma recomendação" viram ruído aqui. -->
          @if (hasResults()) {
          @if (run()?.partial) {
            <p class="text-xs text-warning-strong">
              Análise parcial — a Meta limitou as chamadas ou alguns dados não vieram desta vez. Tente de novo em alguns minutos.
            </p>
          }

          <!-- Scorecard: nota da conta (tom+texto) + maior vazamento + headline -->
          @if (scorecard(); as sc) {
            <section class="flex flex-col gap-3 rounded-lg border border-line bg-panel p-5">
              <div class="flex items-center gap-3">
                <span appBadge [tone]="gradeTone(sc.grade)" size="sm">
                  Nota {{ sc.grade }} · {{ gradeLabel(sc.grade) }}
                </span>
                <span class="text-xs text-muted">Maior oportunidade: {{ leakLabel(sc.biggestLeak) }}</span>
              </div>
              <p class="text-sm text-ink">{{ sc.headline }}</p>
            </section>
          }

          <!-- Faixa de KPIs (gasto/CPA/ROAS) + taxas de funil quando houver -->
          @if (stats().length > 0) {
            <div class="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
              @for (stat of stats(); track stat.label) {
                <div class="flex flex-col gap-1 rounded-lg border border-line bg-panel p-4">
                  <span class="text-xs text-muted">{{ stat.label }}</span>
                  <span class="font-brand text-lg font-semibold text-ink">{{ stat.value }}</span>
                </div>
              }
            </div>
          }

          <!-- Recorte por campanha: o gestor pensa por campanha (não por conta-blob) -->
          @if (campaigns().length > 0) {
            <div class="flex flex-col gap-1">
              <h2 class="font-brand text-sm font-semibold text-ink">Campanhas</h2>
              <p class="text-xs text-muted">
                Análise de cada campanha ativa. Silencie as que o agente não deve acompanhar.
              </p>
            </div>
            <div class="flex flex-col gap-3">
              @for (c of campaigns(); track c.externalId) {
                <article
                  class="flex flex-col gap-2 rounded-lg border border-line bg-panel p-5"
                  [class.opacity-60]="c.muted"
                >
                  <div class="flex items-start justify-between gap-3">
                    <div class="flex flex-col gap-1">
                      <h3 class="font-brand text-base font-semibold text-ink">{{ campaignName(c) }}</h3>
                      <div class="flex flex-wrap items-center gap-2">
                        <span appBadge [tone]="campaignTone(c)" size="sm">{{ campaignStatusLabel(c) }}</span>
                        <span class="text-xs text-muted">Gasto {{ campaignSpend(c) }}</span>
                        @if (c.metrics.cpa !== undefined) {
                          <span class="text-xs text-muted">· Custo por venda {{ campaignCpa(c) }}</span>
                        }
                        @if (c.muted) {
                          <span appBadge size="sm">silenciada</span>
                        }
                      </div>
                    </div>
                    <button
                      type="button"
                      class="shrink-0 rounded-md border border-line px-2 py-1 text-xs text-muted hover:text-ink"
                      [disabled]="mutingId() === c.externalId"
                      (click)="toggleMuted(c)"
                    >
                      {{ mutingId() === c.externalId ? 'Salvando…' : c.muted ? 'Reativar' : 'Silenciar' }}
                    </button>
                  </div>
                  @if (c.summary) {
                    <p class="text-sm text-muted">{{ c.summary }}</p>
                  }
                  @if (c.topFinding) {
                    <div class="rounded-md bg-soft p-3">
                      <span class="text-sm text-ink">{{ c.topFinding.title }}</span>
                    </div>
                  }
                </article>
              }
            </div>
          }

          @if (recommendations().length === 0) {
            <p class="text-sm text-muted">Nenhuma recomendação desta vez.</p>
          } @else {
            <div class="flex flex-col gap-1">
              <h2 class="font-brand text-sm font-semibold text-ink">Recomendações</h2>
              <p class="text-xs text-muted">{{ applicabilityNote }}</p>
            </div>
            <div class="flex flex-col gap-3">
              @for (rec of recommendations(); track rec.id) {
                <article class="flex flex-col gap-2 rounded-lg border border-line bg-panel p-5">
                  <div class="flex items-start justify-between gap-3">
                    <h3 class="font-brand text-base font-semibold text-ink">{{ rec.title }}</h3>
                    <span appBadge [tone]="riskTone(rec.riskLevel)">{{ riskLabel(rec.riskLevel) }}</span>
                  </div>
                  @if (rec.rationale) {
                    <p class="text-sm text-muted">{{ rec.rationale }}</p>
                  }
                  @if (rec.proposedAction) {
                    <div class="rounded-md bg-soft p-3">
                      <span class="text-sm text-ink">Ação sugerida: {{ actionText(rec) }}</span>
                    </div>
                  }
                  <!-- Feedback 👍/👎: ensina o agente (👎 vira memória "não repita isso") -->
                  <div class="flex items-center gap-2 pt-1">
                    <span class="text-xs text-muted">Essa sugestão faz sentido?</span>
                    <button
                      type="button"
                      class="rounded-md border border-line px-2 py-1 text-xs"
                      [class.bg-success-soft]="rec.vote === 'up'"
                      [class.text-success-strong]="rec.vote === 'up'"
                      [class.text-muted]="rec.vote !== 'up'"
                      [attr.aria-pressed]="rec.vote === 'up'"
                      [disabled]="votingId() === rec.id"
                      (click)="vote(rec, 'up')"
                    >
                      {{ rec.vote === 'up' ? '👍 Marcada como útil' : '👍 Útil' }}
                    </button>
                    <button
                      type="button"
                      class="rounded-md border border-line px-2 py-1 text-xs"
                      [class.bg-danger-soft]="rec.vote === 'down'"
                      [class.text-danger-strong]="rec.vote === 'down'"
                      [class.text-muted]="rec.vote !== 'down'"
                      [attr.aria-pressed]="rec.vote === 'down'"
                      [disabled]="votingId() === rec.id"
                      (click)="vote(rec, 'down')"
                    >
                      👎 Não
                    </button>
                    @if (rec.vote === 'down') {
                      <span class="text-xs text-muted">Anotado — o agente evita repetir isso.</span>
                    }
                  </div>
                </article>
              }
            </div>
          }
          }
        </section>
      }

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

  protected readonly applicabilityNote = APPLICABILITY_NOTE;
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

  /** Diagnóstico único da conta (só quando o run trouxe scorecard). */
  protected readonly scorecard = computed<Scorecard | null>(() => this.run()?.metrics?.scorecard ?? null);

  /**
   * Run trouxe algo acionável? (scorecard, KPIs ou recomendações). Se não — ex:
   * conta sem gasto — o resumo já basta; a ressalva "parcial" e o "nenhuma
   * recomendação" viram ruído, então ficam suprimidos.
   */
  protected readonly hasResults = computed<boolean>(
    () =>
      this.scorecard() !== null ||
      this.stats().length > 0 ||
      this.recommendations().length > 0 ||
      this.campaigns().length > 0,
  );

  /** Faixa de KPIs + taxas de funil, já formatada (só o que houver). */
  protected readonly stats = computed<Stat[]>(() => {
    const metrics = this.run()?.metrics;
    if (!metrics) return [];
    const currency = this.account()?.currency ?? DEFAULT_CURRENCY;
    const { kpis, funnel } = metrics;
    const items: Stat[] = [{ label: 'Gasto', value: formatCurrency(kpis.spend, currency) }];
    if (kpis.cpa !== undefined) items.push({ label: 'Custo por venda', value: formatCurrency(kpis.cpa, currency) });
    if (kpis.roas !== undefined) items.push({ label: 'Retorno (ROAS)', value: `${kpis.roas.toFixed(2)}x` });
    if (funnel?.replyRate !== undefined) items.push({ label: 'Taxa de resposta', value: formatPercent(funnel.replyRate) });
    if (funnel?.depthRate !== undefined) items.push({ label: 'Conversas que avançam', value: formatPercent(funnel.depthRate) });
    return items;
  });

  constructor() {
    this.destroyRef.onDestroy(() => {
      this.destroyed = true;
    });
    this.loadAll();
  }

  protected accountName(): string {
    return this.account()?.name ?? this.account()?.adAccountId ?? 'Conta';
  }
  protected accountSubtitle(): string {
    const acc = this.account();
    if (!acc) return 'Análise da conta';
    return `Conta ${acc.adAccountId}${acc.currency ? ` · ${acc.currency}` : ''}`;
  }

  protected riskTone(risk: Recommendation['riskLevel']): RiskTone {
    return RISK_TONE[risk];
  }
  protected riskLabel(risk: Recommendation['riskLevel']): string {
    return RISK_LABEL[risk];
  }
  protected actionText(rec: Recommendation): string {
    const action = rec.proposedAction;
    if (!action) return '';
    const verb = ACTION_LABEL[action.type] ?? 'Revisar';
    const level = LEVEL_LABEL[action.target.level] ?? action.target.level;
    return `${verb} ${level}`;
  }

  protected campaignName(c: Campaign): string {
    return c.name ?? c.externalId;
  }
  /**
   * Precisa de atenção? flag de meta/anomalia OU um achado grave da análise —
   * senão o badge "dentro da meta" contradiz um gargalo crítico exibido logo abaixo.
   */
  private campaignNeedsAttention(c: Campaign): boolean {
    const sev = c.topFinding?.severity;
    return c.flags.length > 0 || sev === 'warning' || sev === 'critical';
  }
  /** Tom+texto (nunca só cor): atenção × dentro da meta. */
  protected campaignTone(c: Campaign): RiskTone {
    return this.campaignNeedsAttention(c) ? 'warning' : 'neutral';
  }
  protected campaignStatusLabel(c: Campaign): string {
    return this.campaignNeedsAttention(c) ? 'atenção' : 'dentro da meta';
  }
  protected campaignSpend(c: Campaign): string {
    return formatCurrency(c.metrics.spend, this.account()?.currency ?? DEFAULT_CURRENCY);
  }
  protected campaignCpa(c: Campaign): string {
    return formatCurrency(c.metrics.cpa ?? 0, this.account()?.currency ?? DEFAULT_CURRENCY);
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

  protected gradeTone(grade: Scorecard['grade']): GradeTone {
    return GRADE_TONE[grade];
  }
  protected gradeLabel(grade: Scorecard['grade']): string {
    return GRADE_LABEL[grade];
  }
  protected leakLabel(leak: Scorecard['biggestLeak']): string {
    return LEAK_LABEL[leak];
  }

  protected vote(rec: Recommendation, vote: 'up' | 'down'): void {
    if (rec.vote === vote) return; // já votado assim
    this.votingId.set(rec.id);
    this.analysisApi.sendFeedback(rec.id, vote).subscribe({
      next: () => {
        // reflete o voto localmente (o backend já registrou + memória em 👎).
        this.recommendations.update((list) =>
          list.map((r) => (r.id === rec.id ? { ...r, vote } : r)),
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
          if (latest.run) this.loadCampaigns();
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

const DEFAULT_CURRENCY = 'BRL';
const CURRENCY_LOCALE = 'pt-BR';

function formatCurrency(value: number, currency: string): string {
  try {
    return new Intl.NumberFormat(CURRENCY_LOCALE, { style: 'currency', currency }).format(value);
  } catch {
    // moeda desconhecida → não quebra a tela; mostra o número puro.
    return value.toFixed(2);
  }
}

function formatPercent(ratio: number): string {
  return `${Math.round(ratio * 100)}%`;
}
