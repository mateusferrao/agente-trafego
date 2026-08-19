import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { HttpErrorResponse } from '@angular/common/http';
import { provideIcons } from '@ng-icons/core';
import { heroSparkles } from '@ng-icons/heroicons/outline';
import { UiBadge, UiButton, UiEmptyState, UiPageHeader, UiSpinner } from '@ui';
import { AccountsApiService } from '@core/api/accounts-api.service';
import { AnalysisApiService } from '@core/api/analysis-api.service';
import type { AdAccountOutput, LatestRunOutput } from '@core/api/generated';

type Recommendation = LatestRunOutput['recommendations'][number];
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

      <!-- Meta do agente (mínima na 3a) -->
      <section class="flex flex-col gap-3 rounded-lg border border-line bg-panel p-5">
        <h2 class="font-brand text-sm font-semibold text-ink">Meta da conta</h2>
        <p class="text-xs text-muted">
          Definir a meta faz o agente comparar o desempenho e priorizar melhor. É opcional.
        </p>
        <div class="flex flex-wrap items-end gap-4">
          <label class="flex flex-col gap-1 text-xs text-muted">
            Custo por venda alvo (R$)
            <input
              type="number"
              min="0"
              step="0.01"
              class="w-40 rounded-md border border-line bg-app px-3 py-2 text-sm text-ink"
              [value]="targetCPA() ?? ''"
              (input)="onCpa($event)"
            />
          </label>
          <label class="flex flex-col gap-1 text-xs text-muted">
            Retorno sobre investimento alvo (ROAS)
            <input
              type="number"
              min="0"
              step="0.1"
              class="w-40 rounded-md border border-line bg-app px-3 py-2 text-sm text-ink"
              [value]="targetROAS() ?? ''"
              (input)="onRoas($event)"
            />
          </label>
          <button appButton variant="secondary" type="button" [disabled]="savingGoals()" (click)="saveGoals()">
            {{ savingGoals() ? 'Salvando…' : 'Salvar meta' }}
          </button>
          @if (goalsSaved()) {
            <span class="text-xs text-success-strong">Meta salva.</span>
          }
          @if (goalsError()) {
            <span class="text-xs text-danger-strong">{{ goalsError() }}</span>
          }
        </div>
      </section>

      <!-- Erro do disparo (ex: já em andamento / limite de custo) -->
      @if (triggerError()) {
        <p class="rounded-lg border border-line bg-panel p-4 text-sm text-danger-strong">
          {{ triggerError() }}
        </p>
      }

      <!-- Resultado -->
      @if (loading()) {
        <div class="flex items-center justify-center gap-3 rounded-lg border border-line bg-panel p-10 text-sm text-muted">
          <app-ui-spinner [size]="20" [stroke]="2" aria-hidden="true" />
          Carregando…
        </div>
      } @else if (analyzing()) {
        <div class="flex items-center justify-center gap-3 rounded-lg border border-line bg-panel p-10 text-sm text-muted">
          <app-ui-spinner [size]="20" [stroke]="2" aria-hidden="true" />
          Analisando sua conta… leva cerca de 1 minuto.
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
          @if (run()?.partial) {
            <p class="text-xs text-warning-strong">
              Análise parcial — alguns dados não puderam ser carregados desta vez.
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

          @if (recommendations().length === 0) {
            <p class="text-sm text-muted">Nenhuma recomendação desta vez.</p>
          } @else {
            <h2 class="font-brand text-sm font-semibold text-ink">Recomendações</h2>
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
                    <div class="flex flex-col gap-1 rounded-md bg-soft p-3">
                      <span class="text-sm text-ink">Ação sugerida: {{ actionText(rec) }}</span>
                      <span class="text-xs text-muted">{{ applicabilityNote }}</span>
                    </div>
                  }
                </article>
              }
            </div>
          }
        </section>
      }
    </div>
  `,
})
export class AccountDetailPage {
  private readonly route = inject(ActivatedRoute);
  private readonly accountsApi = inject(AccountsApiService);
  private readonly analysisApi = inject(AnalysisApiService);
  private readonly destroyRef = inject(DestroyRef);

  private readonly accountId = this.route.snapshot.paramMap.get('id') ?? '';
  private destroyed = false;

  protected readonly applicabilityNote = APPLICABILITY_NOTE;
  protected readonly account = signal<AdAccountOutput | null>(null);
  protected readonly run = signal<LatestRunOutput['run']>(null);
  protected readonly recommendations = signal<Recommendation[]>([]);
  protected readonly loading = signal(true);
  protected readonly analyzing = signal(false);
  protected readonly triggerError = signal<string | null>(null);

  protected readonly targetCPA = signal<number | null>(null);
  protected readonly targetROAS = signal<number | null>(null);
  protected readonly savingGoals = signal(false);
  protected readonly goalsSaved = signal(false);
  protected readonly goalsError = signal<string | null>(null);

  /** Diagnóstico único da conta (só quando o run trouxe scorecard). */
  protected readonly scorecard = computed<Scorecard | null>(() => this.run()?.metrics?.scorecard ?? null);

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

  protected gradeTone(grade: Scorecard['grade']): GradeTone {
    return GRADE_TONE[grade];
  }
  protected gradeLabel(grade: Scorecard['grade']): string {
    return GRADE_LABEL[grade];
  }
  protected leakLabel(leak: Scorecard['biggestLeak']): string {
    return LEAK_LABEL[leak];
  }

  protected onCpa(event: Event): void {
    this.targetCPA.set(parseNumber(event));
    this.clearGoalsFeedback();
  }
  protected onRoas(event: Event): void {
    this.targetROAS.set(parseNumber(event));
    this.clearGoalsFeedback();
  }

  /** confirmação/erro descrevem o último save — some ao editar o campo. */
  private clearGoalsFeedback(): void {
    this.goalsSaved.set(false);
    this.goalsError.set(null);
  }

  protected saveGoals(): void {
    this.savingGoals.set(true);
    this.clearGoalsFeedback();
    const goals = {
      ...(this.targetCPA() !== null ? { targetCPA: this.targetCPA()! } : {}),
      ...(this.targetROAS() !== null ? { targetROAS: this.targetROAS()! } : {}),
    };
    this.analysisApi.updateGoals(this.accountId, goals).subscribe({
      next: () => {
        this.savingGoals.set(false);
        this.goalsSaved.set(true);
      },
      error: (err: unknown) => {
        this.savingGoals.set(false);
        this.goalsError.set(friendlyGoalsError(err));
      },
    });
  }

  protected analyze(): void {
    this.triggerError.set(null);
    this.analyzing.set(true);
    this.analysisApi.triggerRun(this.accountId).subscribe({
      next: () => this.poll(),
      error: (err: unknown) => {
        this.analyzing.set(false);
        this.triggerError.set(friendlyError(err));
      },
    });
  }

  private loadAll(): void {
    this.accountsApi.list().subscribe({
      next: (rows) => this.account.set(rows.find((r) => r.id === this.accountId) ?? null),
      error: () => this.account.set(null),
    });
    this.analysisApi.getAgent(this.accountId).subscribe({
      next: (agent) => {
        this.targetCPA.set(agent.goals.targetCPA ?? null);
        this.targetROAS.set(agent.goals.targetROAS ?? null);
      },
      // meta é opcional; se não carregar, os campos ficam em branco (o usuário
      // ainda pode definir e salvar). Falha silenciosa consciente, sem travar a tela.
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
        }
      },
      error: () => this.loading.set(false),
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

function parseNumber(event: Event): number | null {
  const value = (event.target as HTMLInputElement).value;
  if (value.trim() === '') return null;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function friendlyError(err: unknown): string {
  return backendMessage(err) ?? 'Não consegui iniciar a análise agora. Tente de novo em instantes.';
}

function friendlyGoalsError(err: unknown): string {
  return backendMessage(err) ?? 'Não consegui salvar a meta agora. Tente de novo em instantes.';
}

/** Mensagem amigável vinda da API (controlada) — nunca vaza stack/código técnico. */
function backendMessage(err: unknown): string | null {
  if (err instanceof HttpErrorResponse) {
    const message = (err.error as { message?: string } | null)?.message;
    if (message) return message;
  }
  return null;
}
