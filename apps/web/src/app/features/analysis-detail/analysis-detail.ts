import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import { UiEyebrow, UiStat, UiEvidence, UiMeter } from '@ui';
import { AGENT_NAME } from '@core/brand';
import type { RunDetailOutput } from '@core/api/generated';

type RunView = RunDetailOutput['run'];
type Recommendation = RunDetailOutput['recommendations'][number];
type Campaign = RunDetailOutput['campaigns'][number];
type RunMetrics = NonNullable<NonNullable<RunView>['metrics']>;
type Scorecard = NonNullable<RunMetrics['scorecard']>;
type Waste = NonNullable<RunMetrics['waste']>;
type Tracking = NonNullable<RunMetrics['trackingHealth']>;
type Tier = NonNullable<Campaign['tier']>;
type Stage = NonNullable<Campaign['stage']>;
type StatTone = 'ink' | 'danger' | 'success' | 'accent';

interface VerdictStat {
  readonly label: string;
  readonly value: string;
  readonly tone: StatTone;
}

const ACTION_LABEL: Record<string, string> = {
  pause_entity: 'Pausar',
  resume_entity: 'Reativar',
  adjust_budget: 'Ajustar orçamento',
  set_status: 'Mudar status',
};
const KIND_LABEL: Record<Recommendation['kind'], string> = {
  platform_action: 'posso fazer isso',
  human_direction: 'sugestão pra você',
  insight: 'o que observei',
};
const TIER_LABEL: Record<Tier, string> = {
  winner: 'campeã',
  performer: 'ok',
  underperformer: 'abaixo da meta',
  zombie: 'parada · desperdício',
};
/** cor da barra lateral do card por faixa (tom, nunca só cor — o rótulo em eyebrow acompanha). */
const TIER_BORDER: Record<Tier, string> = {
  winner: 'border-l-success',
  performer: 'border-l-info',
  underperformer: 'border-l-warning',
  zombie: 'border-l-danger',
};
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
const APPLICABILITY_NOTE = 'Sugestão — a aplicação automática chega em breve.';
const LEAK_LABEL: Record<Scorecard['biggestLeak'], string> = {
  consciencia: 'alcançar as pessoas certas',
  engajamento: 'engajamento com os anúncios',
  conversao: 'transformar cliques em vendas',
  receita: 'retorno sobre o investimento',
};

/**
 * Resultado da análise, redesenhado (Fase 2): veredito liderado por dinheiro (sem
 * nota-letra), KPIs/funil em stats+meter, cards de campanha com barra de faixa +
 * evidência (metricRefs), recomendações com eyebrow. Estilo do site (neobrutalista).
 * Sem IO — voto/silenciar sobem como eventos. Reusado por conta (último run) e histórico.
 */
@Component({
  selector: 'app-analysis-detail',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [UiEyebrow, UiStat, UiEvidence, UiMeter],
  template: `
    <section class="flex flex-col gap-5">
      @if (hasResults()) {
        <!-- VEREDITO DO ROI — lidera pelo dinheiro/resultado (pastel + offset, nível Marca) -->
        @if (scorecard(); as sc) {
          <section class="ui-panel-card--brand ui-accent-peach flex flex-col gap-3">
            <div class="flex items-center gap-2">
              <span class="brand-mark" aria-hidden="true"></span>
              <app-ui-eyebrow>A leitura do {{ agentName }}</app-ui-eyebrow>
            </div>
            <p class="font-brand text-xl font-extrabold leading-tight text-ink">{{ sc.headline }}</p>
            @if (verdictStats().length > 0) {
              <div class="flex flex-wrap gap-x-8 gap-y-3">
                @for (s of verdictStats(); track s.label) {
                  <app-ui-stat [label]="s.label" [value]="s.value" [tone]="s.tone" />
                }
              </div>
            }
            <span class="text-xs text-muted">Maior oportunidade: {{ leakLabel(sc.biggestLeak) }}</span>
          </section>
        }

        <!-- Fala do agente (narrativa voiceada) -->
        @if (narrative(); as n) {
          <p class="rounded-lg border border-line bg-panel p-4 text-sm text-ink whitespace-pre-line">{{ n }}</p>
        }

        @if (run()?.partialNote; as note) {
          <p class="text-xs" [class.text-warning-strong]="run()?.partialSeverity === 'hard'" [class.text-muted]="run()?.partialSeverity !== 'hard'">
            {{ note }}
          </p>
        }

        <!-- Ressalva de medição (tracking suspeito) -->
        @if (tracking(); as t) {
          <div class="flex flex-col gap-1 rounded-lg border-2 border-warning bg-warning-soft p-4">
            <app-ui-eyebrow>Medição incompleta</app-ui-eyebrow>
            <p class="text-sm text-ink">
              {{ t.funnelStarted }} conversas e apenas {{ t.trackedConversions }} conversões registradas. Confira o
              rastreamento (pixel/CAPI) antes de decidir pelo custo por conversão.
            </p>
          </div>
        }

        <!-- Funil de conversa (meters) -->
        @if (funnelRates().length > 0) {
          <section class="flex flex-col gap-3 rounded-lg border border-line bg-panel p-4">
            <app-ui-eyebrow>Funil de conversa</app-ui-eyebrow>
            @for (f of funnelRates(); track f.label) {
              <div class="flex flex-col gap-1">
                <div class="flex justify-between text-xs">
                  <span class="text-ink">{{ f.label }}</span>
                  <span class="ui-stat__value text-ink">{{ f.value }}</span>
                </div>
                <app-ui-meter [ratio]="f.ratio" tone="success" />
              </div>
            }
          </section>
        }

        <!-- Dinheiro sem retorno (money shot) -->
        @if (waste(); as w) {
          <section class="ui-panel-card--brand flex flex-col gap-3">
            <app-ui-eyebrow>Dinheiro sem retorno</app-ui-eyebrow>
            @if (w.wastedSpend > 0) {
              <div class="flex items-baseline gap-2">
                <span class="ui-stat__value text-3xl text-danger-strong">{{ money(w.wastedSpend) }}</span>
                <span class="text-sm text-muted">{{ pct(w.wastedPct) }} do gasto — pausar libera esse valor</span>
              </div>
            }
            @if (w.zombies.length > 0) {
              <div class="flex flex-wrap gap-2">
                @for (z of w.zombies; track z.id) {
                  <app-ui-evidence>{{ z.name }} · {{ money(z.spend) }}</app-ui-evidence>
                }
              </div>
            }
            @if (misallocated().length > 0) {
              <div class="flex flex-col gap-1.5">
                <span class="text-xs text-muted">Gasto mal distribuído (consome mais do que entrega):</span>
                @for (m of misallocated(); track m.id) {
                  <div class="flex items-center justify-between gap-3 text-sm">
                    <span class="min-w-0 truncate text-ink">{{ m.name }}</span>
                    <span class="shrink-0 text-xs text-muted">{{ pct(m.spendPct) }} gasto · {{ pct(m.resultPct ?? 0) }} resultado</span>
                  </div>
                }
              </div>
            }
          </section>
        }

        <!-- Campanhas -->
        @if (campaigns().length > 0) {
          <div class="flex flex-col gap-1">
            <h2 class="font-brand text-sm font-semibold text-ink">Campanhas</h2>
            <p class="text-xs text-muted">Análise de cada campanha ativa. Silencie as que o {{ agentName }} não deve acompanhar.</p>
          </div>
          <div class="flex flex-col gap-3">
            @for (c of campaigns(); track c.externalId) {
              <article
                class="flex flex-col gap-3 rounded-lg border border-line border-l-4 bg-panel p-4"
                [class]="tierBorder(c)"
                [class.opacity-60]="c.muted"
              >
                <div class="flex items-start justify-between gap-3">
                  <div class="flex flex-col gap-1">
                    <div class="flex flex-wrap items-center gap-2">
                      @if (c.tier) {
                        <app-ui-eyebrow [class]="tierText(c.tier)">{{ tierLabel(c.tier) }}</app-ui-eyebrow>
                      }
                      @if (c.stage) {
                        <span class="text-[11px] text-muted">· {{ stageLabel(c.stage) }}</span>
                      }
                      @if (c.muted) {
                        <span class="text-[11px] text-muted">· silenciada</span>
                      }
                    </div>
                    <h3 class="font-semibold text-ink">{{ campaignName(c) }}</h3>
                  </div>
                  <div class="flex shrink-0 items-center gap-2">
                    @if (c.tier === 'winner' && !c.muted) {
                      <button
                        type="button"
                        class="rounded-md border border-accent px-2 py-1 text-xs text-accent-strong hover:bg-accent-soft"
                        [disabled]="scalingId() === c.externalId"
                        (click)="onScale(c)"
                      >
                        {{ scalingId() === c.externalId ? 'Propondo…' : 'Escalar' }}
                      </button>
                    }
                    <button
                      type="button"
                      class="rounded-md border border-line px-2 py-1 text-xs text-muted hover:text-ink"
                      [disabled]="mutingId() === c.externalId"
                      (click)="onToggleMute(c)"
                    >
                      {{ mutingId() === c.externalId ? 'Salvando…' : c.muted ? 'Reativar' : 'Silenciar' }}
                    </button>
                  </div>
                </div>

                <!-- métricas inline em mono -->
                <div class="flex flex-wrap gap-x-6 gap-y-1">
                  <span class="flex items-baseline gap-1.5"><app-ui-eyebrow>Gasto</app-ui-eyebrow><b class="ui-stat__value text-sm text-ink">{{ campaignSpend(c) }}</b></span>
                  @if (c.metrics.roas !== undefined) {
                    <span class="flex items-baseline gap-1.5"><app-ui-eyebrow>ROAS</app-ui-eyebrow><b class="ui-stat__value text-sm text-success-strong">{{ c.metrics.roas.toFixed(2) }}x</b></span>
                  }
                  @if (c.metrics.cpa !== undefined) {
                    <span class="flex items-baseline gap-1.5"><app-ui-eyebrow>{{ cpaLabel() }}</app-ui-eyebrow><b class="ui-stat__value text-sm text-ink">{{ campaignCpa(c) }}</b></span>
                  }
                  @if (c.metrics.ctr !== undefined) {
                    <span class="flex items-baseline gap-1.5"><app-ui-eyebrow>CTR</app-ui-eyebrow><b class="ui-stat__value text-sm text-ink">{{ pctRatio(c.metrics.ctr) }}</b></span>
                  }
                </div>

                @if (c.summary) {
                  <p class="text-sm text-ink">{{ c.summary }}</p>
                }
                @if (c.topFinding?.detail) {
                  <p class="text-sm text-muted">{{ c.topFinding?.detail }}</p>
                }
                @if (findingRefs(c).length > 0) {
                  <div class="flex flex-wrap gap-2">
                    @for (r of findingRefs(c); track $index) {
                      <app-ui-evidence [tone]="evidenceTone(c)">{{ r }}</app-ui-evidence>
                    }
                  </div>
                }

                <!-- passo agressivo: o backend pergunta subir seguro vs duplicar (§eco+confirma) -->
                @if (scaleAsk()?.externalId === c.externalId) {
                  <div class="flex flex-col gap-2 rounded-md border border-accent-soft bg-accent-soft p-3">
                    <p class="text-sm text-ink">
                      Esse aumento é grande. Prefere subir o orçamento no limite seguro, ou criar uma cópia
                      separada pra crescer sem arriscar a que já funciona?
                    </p>
                    <div class="flex flex-wrap gap-2">
                      <button
                        type="button"
                        class="rounded-md border border-accent bg-accent px-3 py-1.5 text-xs font-medium text-on-accent hover:bg-accent-strong"
                        (click)="onScaleChoose('raise')"
                      >
                        Subir orçamento +{{ scaleAsk()?.raisePct }}%
                      </button>
                      <button
                        type="button"
                        class="rounded-md border border-line px-3 py-1.5 text-xs text-ink hover:bg-panel-2"
                        (click)="onScaleChoose('duplicate')"
                      >
                        Duplicar (crescer +{{ scaleAsk()?.duplicatePct }}%)
                      </button>
                      <button
                        type="button"
                        class="rounded-md px-3 py-1.5 text-xs text-muted hover:text-ink"
                        (click)="onScaleCancel()"
                      >
                        Agora não
                      </button>
                    </div>
                  </div>
                }
              </article>
            }
          </div>
        }

        <!-- Recomendações -->
        @if (recommendations().length === 0) {
          <p class="text-sm text-muted">Nenhuma recomendação desta vez.</p>
        } @else {
          <div class="flex flex-col gap-1">
            <h2 class="font-brand text-sm font-semibold text-ink">Recomendações</h2>
            <p class="text-xs text-muted">{{ applicabilityNote }}</p>
          </div>
          <div class="flex flex-col gap-3">
            @for (rec of recommendations(); track rec.id) {
              <article class="ui-panel-card--brand flex flex-col gap-2">
                <app-ui-eyebrow [class]="kindText(rec.kind)">{{ kindLabel(rec.kind) }}</app-ui-eyebrow>
                <h3 class="font-brand text-lg font-bold leading-tight text-ink">{{ rec.title }}</h3>
                @if (rec.rationale) {
                  <p class="text-sm text-ink">{{ rec.rationale }}</p>
                }
                @if (rec.kind === 'platform_action' && rec.proposedAction) {
                  <span class="ui-tag-mint w-fit">Ação: {{ actionText(rec) }}</span>
                } @else if (rec.kind === 'human_direction') {
                  <span class="text-xs text-muted">Direção — você aplica. Peça ao {{ agentName }} no WhatsApp se quiser ajuda.</span>
                }
                <div class="flex items-center gap-2 pt-1">
                  <span class="text-xs text-muted">Faz sentido?</span>
                  <button
                    type="button"
                    class="rounded-md border border-line px-2.5 py-1 text-xs font-medium"
                    [class.bg-success-soft]="rec.vote === 'up'"
                    [class.text-success-strong]="rec.vote === 'up'"
                    [class.text-muted]="rec.vote !== 'up'"
                    [attr.aria-pressed]="rec.vote === 'up'"
                    [disabled]="votingId() === rec.id"
                    (click)="onVote(rec, 'up')"
                  >
                    {{ rec.vote === 'up' ? 'Marcada como útil' : 'Útil' }}
                  </button>
                  <button
                    type="button"
                    class="rounded-md border border-line px-2.5 py-1 text-xs font-medium"
                    [class.bg-danger-soft]="rec.vote === 'down'"
                    [class.text-danger-strong]="rec.vote === 'down'"
                    [class.text-muted]="rec.vote !== 'down'"
                    [attr.aria-pressed]="rec.vote === 'down'"
                    [disabled]="votingId() === rec.id"
                    (click)="onVote(rec, 'down')"
                  >
                    Não
                  </button>
                  @if (rec.vote === 'down') {
                    <span class="text-xs text-muted">Anotado — o {{ agentName }} evita repetir isso.</span>
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
  /** id da campanha em escala (CTA "escalar este vencedor"). */
  readonly scalingId = input<string | null>(null);
  /** passo agressivo → escolha inline (subir seguro vs duplicar) no card desta campanha. */
  readonly scaleAsk = input<{ externalId: string; raisePct: number; duplicatePct: number } | null>(null);

  readonly vote = output<{ id: string; vote: 'up' | 'down' }>();
  readonly toggleMute = output<Campaign>();
  readonly scale = output<Campaign>();
  readonly scaleChoose = output<'raise' | 'duplicate'>();
  readonly scaleCancel = output<void>();

  protected readonly applicabilityNote = APPLICABILITY_NOTE;
  protected readonly agentName = AGENT_NAME;

  protected readonly scorecard = computed<Scorecard | null>(() => this.run()?.metrics?.scorecard ?? null);
  protected readonly waste = computed<Waste | null>(() => {
    const w = this.run()?.metrics?.waste ?? null;
    if (!w) return null;
    return w.wastedSpend > 0 || (w.pareto?.misallocated.length ?? 0) > 0 ? w : null;
  });
  protected readonly misallocated = computed(() => this.waste()?.pareto?.misallocated ?? []);
  protected readonly tracking = computed<Tracking | null>(() => {
    const t = this.run()?.metrics?.trackingHealth;
    return t?.suspect ? t : null;
  });
  protected readonly hasResults = computed<boolean>(
    () =>
      this.scorecard() !== null ||
      this.verdictStats().length > 0 ||
      this.recommendations().length > 0 ||
      this.campaigns().length > 0,
  );
  protected readonly narrative = computed(() => this.run()?.narrative ?? this.run()?.summary ?? null);
  protected readonly cpaLabel = computed(() => this.run()?.metrics?.kpis.cpaLabel ?? 'Custo por resultado');

  /** Stats do veredito (dinheiro-primeiro): gasto, CPA, ROAS, parado. */
  protected readonly verdictStats = computed<VerdictStat[]>(() => {
    const metrics = this.run()?.metrics;
    if (!metrics) return [];
    const cur = this.currency();
    const { kpis } = metrics;
    const items: VerdictStat[] = [{ label: 'Gasto', value: formatCurrency(kpis.spend, cur), tone: 'ink' }];
    if (kpis.cpa !== undefined) items.push({ label: this.cpaLabel(), value: formatCurrency(kpis.cpa, cur), tone: 'ink' });
    if (kpis.roas !== undefined) items.push({ label: 'Retorno (ROAS)', value: `${kpis.roas.toFixed(2)}x`, tone: 'success' });
    const w = this.run()?.metrics?.waste;
    if (w && w.wastedSpend > 0) items.push({ label: 'Parado sem retorno', value: formatCurrency(w.wastedSpend, cur), tone: 'danger' });
    return items;
  });

  /** Funil de conversa como taxas (meter). */
  protected readonly funnelRates = computed<{ label: string; value: string; ratio: number }[]>(() => {
    const funnel = this.run()?.metrics?.funnel;
    if (!funnel) return [];
    const out: { label: string; value: string; ratio: number }[] = [];
    if (funnel.replyRate !== undefined) out.push({ label: 'Taxa de resposta', value: formatPercent(funnel.replyRate), ratio: funnel.replyRate });
    if (funnel.depthRate !== undefined) out.push({ label: 'Conversas que avançam', value: formatPercent(funnel.depthRate), ratio: funnel.depthRate });
    return out;
  });

  protected onVote(rec: Recommendation, vote: 'up' | 'down'): void {
    this.vote.emit({ id: rec.id, vote });
  }
  protected onToggleMute(c: Campaign): void {
    this.toggleMute.emit(c);
  }
  protected onScale(c: Campaign): void {
    this.scale.emit(c);
  }
  protected onScaleChoose(choice: 'raise' | 'duplicate'): void {
    this.scaleChoose.emit(choice);
  }
  protected onScaleCancel(): void {
    this.scaleCancel.emit();
  }

  protected kindLabel(kind: Recommendation['kind']): string {
    return KIND_LABEL[kind];
  }
  protected kindText(kind: Recommendation['kind']): string {
    return kind === 'platform_action' ? 'text-accent-strong' : 'text-muted';
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
  protected tierLabel(tier: Tier): string {
    return TIER_LABEL[tier];
  }
  protected tierBorder(c: Campaign): string {
    return c.tier ? TIER_BORDER[c.tier] : 'border-l-line';
  }
  protected tierText(tier: Tier): string {
    const t: Record<Tier, string> = {
      winner: 'text-success-strong',
      performer: 'text-info-strong',
      underperformer: 'text-warning-strong',
      zombie: 'text-danger-strong',
    };
    return t[tier];
  }
  protected stageLabel(stage: Stage): string {
    return STAGE_LABEL[stage];
  }
  /**
   * metricRefs do achado principal (evidência) — vazio se ausente (histórico).
   * A LLM emite label + valor crus e inconsistentes (ex.: "ReplyRate" 0.9173,
   * "CPA atual" 2.2065, "Flag" "cpa_acima_da_meta"); aqui deixamos amigável de
   * forma determinística — rótulo em PT/humanizado + valor formatado pelo tipo
   * inferido do rótulo (taxa → %, custo → moeda, ROAS → ×, contagem → inteiro),
   * e valores string humanizados. Não toca no tom da LLM. Devolve o texto pronto.
   */
  protected findingRefs(c: Campaign): string[] {
    return (c.topFinding?.metricRefs ?? []).map((r) => this.evidenceText(r));
  }

  private evidenceText(ref: { label: string; value: number | string }): string {
    const key = normalizeMetricKey(ref.label);
    const meta = METRIC_META[key];
    const kind = meta?.kind ?? inferEvidenceKind(key);
    let label = meta?.label ?? humanizeText(ref.label);
    // A LLM às vezes manda o número como string ("2.2065") — trata como número.
    const num = typeof ref.value === 'number' ? ref.value : parseNumeric(ref.value);
    let value: string;
    if (num !== null) {
      value = this.formatByKind(num, kind);
    } else {
      value = humanizeText(String(ref.value));
      // rótulos genéricos ("flag"/"status"/"sinal") não agregam — o valor já fala.
      if (GENERIC_LABEL_KEYS.has(key)) label = '';
    }
    return `${label} ${value}`.replace(/\s+/g, ' ').trim();
  }

  private formatByKind(v: number, kind: EvidenceKind): string {
    switch (kind) {
      case 'rate': {
        // Premissa: nossos números vêm como RAZÃO (0..1, ex. CTR 0.0116 = 1,16%) ou já em %
        // (>1). Zona cega conhecida: uma taxa <1% dada crua em percent (0.8 = 0,8%) viraria
        // 80% — não ocorre no pipeline atual (o brief emite razão), mas a origem é da LLM.
        const p = Math.abs(v) <= 1 ? v * 100 : v;
        return `${trimNumber(p, Math.abs(p) < 10 ? 2 : 0)}%`;
      }
      case 'currency':
        return formatCurrency(v, this.currency());
      case 'ratio':
        return `${trimNumber(v, 2)}x`;
      case 'decimal':
        return trimNumber(v, 1);
      case 'count':
        return formatInteger(v);
      default:
        return Number.isInteger(v) ? formatInteger(v) : trimNumber(v, 2);
    }
  }
  protected evidenceTone(c: Campaign): 'neutral' | 'danger' | 'success' {
    const sev = c.topFinding?.severity;
    if (sev === 'critical') return 'danger';
    if (c.tier === 'winner') return 'success';
    return 'neutral';
  }
  protected money(value: number): string {
    return formatCurrency(value, this.currency());
  }
  protected pct(value: number): string {
    return `${Math.round(value)}%`;
  }
  protected pctRatio(ratio: number): string {
    return `${(ratio * 100).toFixed(2)}%`;
  }
  protected campaignSpend(c: Campaign): string {
    return formatCurrency(c.metrics.spend, this.currency());
  }
  protected campaignCpa(c: Campaign): string {
    return formatCurrency(c.metrics.cpa ?? 0, this.currency());
  }
  protected leakLabel(leak: Scorecard['biggestLeak']): string {
    return LEAK_LABEL[leak];
  }
}

const DEFAULT_CURRENCY = 'BRL';
const CURRENCY_LOCALE = 'pt-BR';

/** Como formatar o valor de uma evidência (chip de metricRef). */
type EvidenceKind = 'rate' | 'currency' | 'ratio' | 'decimal' | 'count' | 'raw';

/**
 * Métricas conhecidas → rótulo em PT + tipo de formatação. Cobre as chaves que a
 * LLM costuma citar (cruas, em inglês/camelCase, ou já em PT). Chave desconhecida
 * cai no rótulo original + formatação numérica genérica (sem inventar semântica).
 */
const METRIC_META: Record<string, { label: string; kind: EvidenceKind }> = {
  replyrate: { label: 'Taxa de resposta', kind: 'rate' },
  taxaderesposta: { label: 'Taxa de resposta', kind: 'rate' },
  depthrate: { label: 'Conversas que avançam', kind: 'rate' },
  conversasqueavancam: { label: 'Conversas que avançam', kind: 'rate' },
  ctr: { label: 'CTR', kind: 'rate' },
  cvr: { label: 'Taxa de conversão', kind: 'rate' },
  conversionrate: { label: 'Taxa de conversão', kind: 'rate' },
  taxadeconversao: { label: 'Taxa de conversão', kind: 'rate' },
  hookrate: { label: 'Retenção inicial', kind: 'rate' },
  cpa: { label: 'CPA', kind: 'currency' },
  cpc: { label: 'CPC', kind: 'currency' },
  cpm: { label: 'CPM', kind: 'currency' },
  spend: { label: 'Gasto', kind: 'currency' },
  gasto: { label: 'Gasto', kind: 'currency' },
  revenue: { label: 'Receita', kind: 'currency' },
  receita: { label: 'Receita', kind: 'currency' },
  roas: { label: 'ROAS', kind: 'ratio' },
  frequency: { label: 'Frequência', kind: 'decimal' },
  frequencia: { label: 'Frequência', kind: 'decimal' },
  conversions: { label: 'Conversões', kind: 'count' },
  conversoes: { label: 'Conversões', kind: 'count' },
  results: { label: 'Resultados', kind: 'count' },
  resultados: { label: 'Resultados', kind: 'count' },
  clicks: { label: 'Cliques', kind: 'count' },
  cliques: { label: 'Cliques', kind: 'count' },
  impressions: { label: 'Impressões', kind: 'count' },
  impressoes: { label: 'Impressões', kind: 'count' },
  reach: { label: 'Alcance', kind: 'count' },
  alcance: { label: 'Alcance', kind: 'count' },
  purchases: { label: 'Compras', kind: 'count' },
  compras: { label: 'Compras', kind: 'count' },
  leads: { label: 'Leads', kind: 'count' },
};

/** Normaliza o rótulo p/ casar no mapa: minúsculas, sem acentos nem separadores. */
function normalizeMetricKey(label: string): string {
  return label
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]/g, '');
}

/** R\u00f3tulos gen\u00e9ricos que n\u00e3o agregam ao lado do valor (o valor j\u00e1 descreve). */
const GENERIC_LABEL_KEYS = new Set(['flag', 'status', 'sinal', 'motivo', 'reason']);
/** Siglas que ficam em CAIXA ALTA ao humanizar texto cru. */
const ACRONYMS = new Set(['cpa', 'cpc', 'cpm', 'cpl', 'cpv', 'ctr', 'roas', 'roi']);

/**
 * Infere o tipo de formata\u00e7\u00e3o por TOKEN presente na chave (cobre r\u00f3tulos compostos
 * que o mapa exato n\u00e3o pega: "CPA atual", "Delta CPA vs baseline"). Custo antes de
 * taxa (sen\u00e3o "cpa" cairia em rate). Chave sem token conhecido \u2192 cru.
 */
function inferEvidenceKind(key: string): EvidenceKind {
  if (/(cpa|cpc|cpm|cpl|cpv|spend|gasto|custo|receita|revenue|budget|orcamento|ticket)/.test(key)) return 'currency';
  if (/roas/.test(key)) return 'ratio';
  if (/(taxa|rate|ctr|resposta|profundidade)/.test(key)) return 'rate';
  if (/frequenc/.test(key)) return 'decimal';
  if (/(conversas|conversoes|conversions|cliques|clicks|leads|compras|purchases|impress|alcance|reach|resultados|results)/.test(key)) {
    return 'count';
  }
  return 'raw';
}

/** String estritamente num\u00e9rica ("2.2065", "-1,3", "133") \u2192 n\u00famero; sen\u00e3o null. */
function parseNumeric(raw: string): number | null {
  const t = raw.trim();
  if (!/^-?\d+([.,]\d+)?$/.test(t)) return null;
  const n = Number(t.replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

/** snake_case/camelCase cru \u2192 texto leg\u00edvel; siglas conhecidas em caixa alta. */
function humanizeText(raw: string): string {
  const spaced = raw
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim();
  return spaced
    .split(' ')
    .map((w) => (ACRONYMS.has(w.toLowerCase()) ? w.toUpperCase() : w))
    .join(' ');
}

function trimNumber(value: number, maxDecimals: number): string {
  return new Intl.NumberFormat(CURRENCY_LOCALE, { maximumFractionDigits: maxDecimals }).format(value);
}

function formatInteger(value: number): string {
  return new Intl.NumberFormat(CURRENCY_LOCALE, { maximumFractionDigits: 0 }).format(value);
}

function formatCurrency(value: number, currency: string): string {
  try {
    return new Intl.NumberFormat(CURRENCY_LOCALE, { style: 'currency', currency }).format(value);
  } catch {
    return value.toFixed(2);
  }
}

function formatPercent(ratio: number): string {
  return `${Math.round(ratio * 100)}%`;
}
