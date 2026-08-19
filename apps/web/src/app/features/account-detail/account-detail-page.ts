import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { toast } from 'ngx-sonner';
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
          <!-- Sem resultados (ex: conta sem gasto): o resumo acima já basta; a
               ressalva "parcial" e o "nenhuma recomendação" viram ruído aqui. -->
          @if (hasResults()) {
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

      <!-- Configuração do agente: secundária ao resultado, recolhível -->
      <details class="rounded-lg border border-line bg-panel">
        <summary class="cursor-pointer px-5 py-4 font-brand text-sm font-semibold text-ink">
          Configuração do agente
        </summary>
        <div class="flex flex-col gap-6 border-t border-line px-5 py-5">
          <!-- Meta do agente (mínima na 3a) -->
          <div class="flex flex-col gap-3">
            <h3 class="font-brand text-sm font-semibold text-ink">Meta da conta</h3>
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
            </div>
          </div>

          <!-- Freio self-service: pausar as análises automáticas (§8 kill-switch) -->
          <div class="flex flex-wrap items-center justify-between gap-3 border-t border-line pt-5">
            <div class="flex flex-col gap-1">
              <h3 class="font-brand text-sm font-semibold text-ink">Análises automáticas</h3>
              <p class="text-xs text-muted">
                {{ paused() ? 'Pausadas — o agente não analisa sozinho nem te avisa no WhatsApp.' : 'Ativas — o agente analisa no ritmo configurado e te avisa no WhatsApp.' }}
              </p>
            </div>
            <button appButton variant="secondary" type="button" [disabled]="pausing()" (click)="togglePaused()">
              {{ pausing() ? 'Salvando…' : paused() ? 'Retomar' : 'Pausar' }}
            </button>
          </div>
        </div>
      </details>
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

  protected readonly targetCPA = signal<number | null>(null);
  protected readonly targetROAS = signal<number | null>(null);
  protected readonly savingGoals = signal(false);
  protected readonly paused = signal(false);
  protected readonly pausing = signal(false);
  protected readonly votingId = signal<string | null>(null);

  /** Diagnóstico único da conta (só quando o run trouxe scorecard). */
  protected readonly scorecard = computed<Scorecard | null>(() => this.run()?.metrics?.scorecard ?? null);

  /**
   * Run trouxe algo acionável? (scorecard, KPIs ou recomendações). Se não — ex:
   * conta sem gasto — o resumo já basta; a ressalva "parcial" e o "nenhuma
   * recomendação" viram ruído, então ficam suprimidos.
   */
  protected readonly hasResults = computed<boolean>(
    () => this.scorecard() !== null || this.stats().length > 0 || this.recommendations().length > 0,
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
  }
  protected onRoas(event: Event): void {
    this.targetROAS.set(parseNumber(event));
  }

  protected saveGoals(): void {
    this.savingGoals.set(true);
    const goals = {
      ...(this.targetCPA() !== null ? { targetCPA: this.targetCPA()! } : {}),
      ...(this.targetROAS() !== null ? { targetROAS: this.targetROAS()! } : {}),
    };
    this.analysisApi.updateGoals(this.accountId, goals).subscribe({
      next: () => {
        this.savingGoals.set(false);
        toast.success('Meta salva');
      },
      // erro amigável já vem do interceptor global (api-request.interceptor).
      error: () => this.savingGoals.set(false),
    });
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
      next: (agent) => {
        this.targetCPA.set(agent.goals.targetCPA ?? null);
        this.targetROAS.set(agent.goals.targetROAS ?? null);
        this.paused.set(agent.paused);
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
