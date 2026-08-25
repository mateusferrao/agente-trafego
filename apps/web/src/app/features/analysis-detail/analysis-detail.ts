import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import { UiBadge } from '@ui';
import type { RunDetailOutput } from '@core/api/generated';

type RunView = RunDetailOutput['run'];
type Recommendation = RunDetailOutput['recommendations'][number];
type Campaign = RunDetailOutput['campaigns'][number];
type RunMetrics = NonNullable<NonNullable<RunView>['metrics']>;
type Scorecard = NonNullable<RunMetrics['scorecard']>;
/** Desperdício + saúde da medição (§Bloco 2) — do snapshot do run. */
type Waste = NonNullable<RunMetrics['waste']>;
type Tracking = NonNullable<RunMetrics['trackingHealth']>;
type RiskTone = 'neutral' | 'warning' | 'danger';
export type GradeTone = 'success' | 'info' | 'warning' | 'danger';
/** Faixa de desempenho da campanha (do backend) — tom+texto, nunca só cor. */
type Tier = NonNullable<Campaign['tier']>;
type TierTone = 'success' | 'info' | 'warning' | 'danger';
/** Estágio de público da campanha (§Bloco 2) — rótulo descritivo, sem juízo. */
type Stage = NonNullable<Campaign['stage']>;

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
/** Formato da recomendação (S2) em linguagem de gente — status = tom+texto. */
const KIND_LABEL: Record<Recommendation['kind'], string> = {
  platform_action: 'posso fazer isso',
  human_direction: 'sugestão pra você',
  insight: 'o que observei',
};
const KIND_TONE: Record<Recommendation['kind'], 'info' | 'neutral'> = {
  platform_action: 'info',
  human_direction: 'neutral',
  insight: 'neutral',
};
/** Rótulo PT-BR de cada faixa (sem jargão). */
const TIER_LABEL: Record<Tier, string> = {
  winner: 'campeã',
  performer: 'ok',
  underperformer: 'abaixo da meta',
  zombie: 'parada (desperdício)',
};
/** Tom da faixa (acompanha o rótulo — status = tom+texto). */
const TIER_TONE: Record<Tier, TierTone> = {
  winner: 'success',
  performer: 'info',
  underperformer: 'warning',
  zombie: 'danger',
};
/** Rótulo PT-BR do estágio de público (descritivo — sem tom de bom/ruim). */
const STAGE_LABEL: Record<Stage, string> = {
  prospecting: 'prospecção',
  remarketing: 'remarketing',
  unknown: 'público indefinido',
};
const LEVEL_LABEL: Record<string, string> = {
  account: 'conta',
  campaign: 'campanha',
  adset: 'conjunto',
  ad: 'anúncio',
};

/** aplicação de ações chega na fase de escrita (Fatia 5) — texto único (decisão 13). */
const APPLICABILITY_NOTE = 'Sugestão — a aplicação automática chega em breve.';

/** Nota da conta (scorecard) → tom+texto (nunca só cor — docs/DESIGN.md). */
export const GRADE_TONE: Record<Scorecard['grade'], GradeTone> = {
  A: 'success',
  B: 'info',
  C: 'warning',
  D: 'danger',
};
export const GRADE_LABEL: Record<Scorecard['grade'], string> = {
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
 * Renderização apresentacional do resultado de uma análise: resumo + ressalva
 * "parcial" + scorecard + faixa de KPIs + cartões por campanha + recomendações
 * (👍/👎). Sem IO — voto/silenciar sobem como eventos; o container decide o que
 * fazer. Reusada pelo detalhe da conta (último run) e pelo detalhe de um run do
 * histórico. Segue docs/DESIGN.md (status=tom+texto).
 */
@Component({
  selector: 'app-analysis-detail',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [UiBadge],
  template: `
    <section class="flex flex-col gap-4">
      @if (run()?.summary) {
        <p class="rounded-lg border border-line bg-panel p-5 text-sm text-ink">{{ run()?.summary }}</p>
      }
      <!-- Sem resultados (ex: conta sem gasto): o resumo acima já basta; a
           ressalva "parcial" e o "nenhuma recomendação" viram ruído aqui. -->
      @if (hasResults()) {
        <!-- Nota de degradação PROPORCIONAL: hard (dado faltando) = alerta; soft
             (métricas ok, só criativo/campanha) = nota discreta. Texto vem do backend. -->
        @if (run()?.partialNote; as note) {
          <p
            class="text-xs"
            [class.text-warning-strong]="run()?.partialSeverity === 'hard'"
            [class.text-muted]="run()?.partialSeverity !== 'hard'"
          >
            {{ note }}
          </p>
        }

        <!-- Ressalva de medição: muita conversa e pouca conversão registrada = rastreamento suspeito -->
        @if (tracking(); as t) {
          <div class="flex flex-col gap-1 rounded-lg border border-warning/40 bg-warning-soft p-4">
            <span class="text-sm font-medium text-warning-strong">A medição de resultados parece incompleta</span>
            <p class="text-sm text-ink">
              {{ t.funnelStarted }} conversas e apenas {{ t.trackedConversions }} conversões registradas. Confira o
              rastreamento de conversões (o pixel/rastreamento do site) antes de decidir pelo custo por conversão.
            </p>
          </div>
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

        <!-- Desperdício (§Bloco 2): o "money shot" — quanto queima + gasto mal distribuído -->
        @if (waste(); as w) {
          <section class="flex flex-col gap-3 rounded-lg border border-line bg-panel p-5">
            <div class="flex flex-col gap-1">
              <h2 class="font-brand text-sm font-semibold text-ink">Dinheiro sem retorno</h2>
              @if (w.wastedSpend > 0) {
                <p class="text-sm text-ink">
                  <span class="font-semibold text-warning-strong">{{ money(w.wastedSpend) }}</span>
                  ({{ pct(w.wastedPct) }}) em campanhas paradas — pausá-las libera esse valor.
                </p>
              }
            </div>

            @if (w.zombies.length > 0) {
              <ul class="flex flex-col gap-1.5">
                @for (z of w.zombies; track z.id) {
                  <li class="flex items-center justify-between gap-3 rounded-md bg-soft px-3 py-2 text-sm">
                    <span class="min-w-0 truncate text-ink">{{ z.name }}</span>
                    <span class="shrink-0 text-muted">{{ money(z.spend) }}</span>
                  </li>
                }
              </ul>
            }

            @if (misallocated().length > 0) {
              <div class="flex flex-col gap-1.5">
                <span class="text-xs text-muted">Gasto mal distribuído — consomem mais do que entregam:</span>
                <ul class="flex flex-col gap-1.5">
                  @for (m of misallocated(); track m.id) {
                    <li class="flex flex-col gap-0.5 rounded-md bg-soft px-3 py-2 text-sm">
                      <span class="min-w-0 truncate text-ink">{{ m.name }}</span>
                      <span class="text-xs text-muted">
                        consome {{ pct(m.spendPct) }} do gasto e entrega {{ pct(m.resultPct ?? 0) }} dos resultados
                      </span>
                    </li>
                  }
                </ul>
              </div>
            }
          </section>
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
                    <div class="flex flex-wrap items-center gap-2">
                      <h3 class="font-brand text-base font-semibold text-ink">{{ campaignName(c) }}</h3>
                      @if (c.tier) {
                        <span appBadge [tone]="tierTone(c.tier)" size="sm">{{ tierLabel(c.tier) }}</span>
                      }
                      @if (c.stage) {
                        <span appBadge size="sm">{{ stageLabel(c.stage) }}</span>
                      }
                    </div>
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
                    (click)="onToggleMute(c)"
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
                  <div class="flex flex-wrap items-center gap-2">
                    <h3 class="font-brand text-base font-semibold text-ink">{{ rec.title }}</h3>
                    <span appBadge [tone]="kindTone(rec.kind)" size="sm">{{ kindLabel(rec.kind) }}</span>
                    @if (recTier(rec); as t) {
                      <span appBadge [tone]="tierTone(t)" size="sm">{{ tierLabel(t) }}</span>
                    }
                  </div>
                  <span appBadge [tone]="riskTone(rec.riskLevel)">{{ riskLabel(rec.riskLevel) }}</span>
                </div>
                @if (rec.rationale) {
                  <p class="text-sm text-muted">{{ rec.rationale }}</p>
                }
                @if (rec.kind === 'platform_action' && rec.proposedAction) {
                  <div class="rounded-md bg-soft p-3">
                    <span class="text-sm text-ink">Ação sugerida: {{ actionText(rec) }}</span>
                  </div>
                } @else if (rec.kind === 'human_direction') {
                  <div class="rounded-md bg-soft p-3">
                    <span class="text-sm text-ink">Direção — você aplica. Peça no WhatsApp se quiser ajuda.</span>
                  </div>
                } @else if (rec.kind === 'platform_action') {
                  <!-- defensivo: platform_action sempre carrega ação (invariante do backend);
                       fallback caso uma linha legada venha sem proposedAction. -->
                  <div class="rounded-md bg-soft p-3">
                    <span class="text-sm text-muted">{{ applicabilityNote }}</span>
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
                    (click)="onVote(rec, 'up')"
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
                    (click)="onVote(rec, 'down')"
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
  `,
})
export class AnalysisDetail {
  readonly run = input<RunView>(null);
  readonly campaigns = input<Campaign[]>([]);
  readonly recommendations = input<Recommendation[]>([]);
  readonly currency = input<string>(DEFAULT_CURRENCY);
  readonly votingId = input<string | null>(null);
  readonly mutingId = input<string | null>(null);

  readonly vote = output<{ id: string; vote: 'up' | 'down' }>();
  readonly toggleMute = output<Campaign>();

  protected readonly applicabilityNote = APPLICABILITY_NOTE;

  /** Diagnóstico único da conta (só quando o run trouxe scorecard). */
  protected readonly scorecard = computed<Scorecard | null>(() => this.run()?.metrics?.scorecard ?? null);

  /** Desperdício do run — só renderiza quando há zumbis OU gasto mal distribuído. */
  protected readonly waste = computed<Waste | null>(() => {
    const w = this.run()?.metrics?.waste ?? null;
    if (!w) return null;
    return w.wastedSpend > 0 || (w.pareto?.misallocated.length ?? 0) > 0 ? w : null;
  });
  /** Itens mal alocados do Pareto (gasta mais do que entrega) — vazio = não mostra. */
  protected readonly misallocated = computed(() => this.waste()?.pareto?.misallocated ?? []);
  /** Saúde da medição — só quando suspeita (o backend só preenche nesse caso). */
  protected readonly tracking = computed<Tracking | null>(() => {
    const t = this.run()?.metrics?.trackingHealth;
    return t?.suspect ? t : null;
  });

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
    const currency = this.currency();
    const { kpis, funnel } = metrics;
    const items: Stat[] = [{ label: 'Gasto', value: formatCurrency(kpis.spend, currency) }];
    if (kpis.cpa !== undefined) items.push({ label: 'Custo por venda', value: formatCurrency(kpis.cpa, currency) });
    if (kpis.roas !== undefined) items.push({ label: 'Retorno (ROAS)', value: `${kpis.roas.toFixed(2)}x` });
    if (funnel?.replyRate !== undefined) items.push({ label: 'Taxa de resposta', value: formatPercent(funnel.replyRate) });
    if (funnel?.depthRate !== undefined) items.push({ label: 'Conversas que avançam', value: formatPercent(funnel.depthRate) });
    return items;
  });

  protected onVote(rec: Recommendation, vote: 'up' | 'down'): void {
    this.vote.emit({ id: rec.id, vote });
  }

  protected onToggleMute(c: Campaign): void {
    this.toggleMute.emit(c);
  }

  protected riskTone(risk: Recommendation['riskLevel']): RiskTone {
    return RISK_TONE[risk];
  }
  protected riskLabel(risk: Recommendation['riskLevel']): string {
    return RISK_LABEL[risk];
  }
  protected kindLabel(kind: Recommendation['kind']): string {
    return KIND_LABEL[kind];
  }
  protected kindTone(kind: Recommendation['kind']): 'info' | 'neutral' {
    return KIND_TONE[kind];
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

  /** Índice externalId → faixa, p/ cruzar o tier nas recomendações (task 3b). */
  private readonly tierByCampaign = computed<ReadonlyMap<string, Tier>>(() => {
    const map = new Map<string, Tier>();
    for (const c of this.campaigns()) if (c.tier) map.set(c.externalId, c.tier);
    return map;
  });

  protected tierLabel(tier: Tier): string {
    return TIER_LABEL[tier];
  }
  protected tierTone(tier: Tier): TierTone {
    return TIER_TONE[tier];
  }
  protected stageLabel(stage: Stage): string {
    return STAGE_LABEL[stage];
  }
  /** Valor monetário na moeda da conta (desperdício/zumbis). */
  protected money(value: number): string {
    return formatCurrency(value, this.currency());
  }
  /** Percentuais do desperdício já vêm 0-100 do backend — só arredonda + sufixo. */
  protected pct(value: number): string {
    return `${Math.round(value)}%`;
  }
  /**
   * Faixa da campanha-alvo de uma recomendação (só quando a ação mira uma campanha
   * e ela está entre as campanhas já carregadas). Sem faixa → não renderiza badge.
   */
  protected recTier(rec: Recommendation): Tier | null {
    const action = rec.proposedAction;
    if (!action || action.target.level !== 'campaign') return null;
    return this.tierByCampaign().get(action.target.id) ?? null;
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
    return formatCurrency(c.metrics.spend, this.currency());
  }
  protected campaignCpa(c: Campaign): string {
    return formatCurrency(c.metrics.cpa ?? 0, this.currency());
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
