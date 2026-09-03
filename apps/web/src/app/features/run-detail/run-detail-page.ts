import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { toast } from 'ngx-sonner';
import { UiButton, UiEmptyState, UiPageHeader, UiSpinner } from '@ui';
import { AccountsApiService } from '@core/api/accounts-api.service';
import { AnalysisApiService } from '@core/api/analysis-api.service';
import type { AdAccountOutput, RunDetailOutput } from '@core/api/generated';
import { AnalysisDetail } from '../analysis-detail/analysis-detail';

type RunView = RunDetailOutput['run'];
type Recommendation = RunDetailOutput['recommendations'][number];
type Campaign = RunDetailOutput['campaigns'][number];

const DEFAULT_CURRENCY = 'BRL';
const DATETIME_LOCALE = 'pt-BR';

/**
 * Detalhe de um run do histórico: reusa `app-analysis-detail` para renderizar o
 * resultado (resumo + scorecard + KPIs + campanhas + recomendações). Avisa quando
 * não é o run mais recente (link p/ o atual). Segue docs/DESIGN.md.
 */
@Component({
  selector: 'app-run-detail-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, UiButton, UiEmptyState, UiPageHeader, UiSpinner, AnalysisDetail],
  template: `
    <div class="flex flex-col gap-8">
      <div class="flex flex-col gap-1">
        <a [routerLink]="['/accounts', accountId]" class="text-xs text-muted hover:text-ink">← {{ accountName() }}</a>
        <app-ui-page-header title="Análise" [subtitle]="subtitle()" />
      </div>

      @if (loading()) {
        <div class="flex items-center justify-center gap-3 rounded-lg border border-line bg-panel p-10 text-sm text-muted">
          <app-ui-spinner [size]="20" [stroke]="2" aria-hidden="true" />
          Carregando…
        </div>
      } @else if (run() === null) {
        <app-ui-empty-state
          brand
          title="Análise não encontrada"
          description="Essa análise não existe ou não está mais disponível."
        >
          <a appButton variant="primary" [routerLink]="['/accounts', accountId]" actions>Ver a conta</a>
        </app-ui-empty-state>
      } @else {
        @if (!isLatest()) {
          <div class="flex flex-wrap items-center gap-2 rounded-lg border border-line bg-soft p-4 text-sm text-ink">
            <span>
              @if (runDate()) {
                Você está vendo uma análise de {{ runDate() }} — não é a mais recente.
              } @else {
                Você está vendo uma análise que não é a mais recente.
              }
            </span>
            <a [routerLink]="['/accounts', accountId]" class="underline">ver a mais recente</a>
          </div>
        }
        <app-analysis-detail
          [run]="run()"
          [campaigns]="campaigns()"
          [recommendations]="recommendations()"
          [currency]="currency()"
          [votingId]="votingId()"
          [mutingId]="mutingId()"
          [canScale]="false"
          (vote)="vote($event)"
          (toggleMute)="toggleMuted($event)"
        />
      }
    </div>
  `,
})
export class RunDetailPage {
  private readonly route = inject(ActivatedRoute);
  private readonly accountsApi = inject(AccountsApiService);
  private readonly analysisApi = inject(AnalysisApiService);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly accountId = this.route.snapshot.paramMap.get('id') ?? '';
  private readonly runId = this.route.snapshot.paramMap.get('runId') ?? '';
  private destroyed = false;

  protected readonly account = signal<AdAccountOutput | null>(null);
  protected readonly run = signal<RunView>(null);
  protected readonly recommendations = signal<Recommendation[]>([]);
  protected readonly campaigns = signal<Campaign[]>([]);
  protected readonly isLatest = signal(true);
  protected readonly loading = signal(true);
  protected readonly votingId = signal<string | null>(null);
  protected readonly mutingId = signal<string | null>(null);

  protected readonly currency = computed(() => this.account()?.currency ?? DEFAULT_CURRENCY);

  constructor() {
    this.destroyRef.onDestroy(() => {
      this.destroyed = true;
    });
    this.load();
  }

  protected accountName(): string {
    return this.account()?.name ?? this.account()?.adAccountId ?? 'Conta';
  }
  protected subtitle(): string {
    const date = this.runDate();
    return date ? `Análise de ${date}` : 'Análise da conta';
  }
  /** Data do run (concluído; cai no início se ainda não tiver terminado). */
  protected runDate(): string {
    const r = this.run();
    const iso = r?.finishedAt ?? r?.startedAt;
    return iso ? formatDateTime(iso) : '';
  }

  protected vote(event: { id: string; vote: 'up' | 'down' }): void {
    const rec = this.recommendations().find((r) => r.id === event.id);
    if (rec?.vote === event.vote) return;
    this.votingId.set(event.id);
    this.analysisApi.sendFeedback(event.id, event.vote).subscribe({
      next: () => {
        this.recommendations.update((list) =>
          list.map((r) => (r.id === event.id ? { ...r, vote: event.vote } : r)),
        );
        this.votingId.set(null);
      },
      // erro amigável já vem do interceptor global.
      error: () => this.votingId.set(null),
    });
  }

  protected toggleMuted(c: Campaign): void {
    this.mutingId.set(c.externalId);
    const req = c.muted
      ? this.analysisApi.unmuteCampaign(this.accountId, c.externalId)
      : this.analysisApi.muteCampaign(this.accountId, c.externalId);
    req.subscribe({
      next: (out) => {
        const mutedSet = new Set(out.campaignIds);
        this.campaigns.update((list) => list.map((x) => ({ ...x, muted: mutedSet.has(x.externalId) })));
        this.mutingId.set(null);
        toast.success(c.muted ? 'Campanha reativada' : 'Campanha silenciada');
      },
      // erro amigável já vem do interceptor global.
      error: () => this.mutingId.set(null),
    });
  }

  private load(): void {
    this.accountsApi.list().subscribe({
      next: (rows) => this.account.set(rows.find((r) => r.id === this.accountId) ?? null),
      error: () => this.account.set(null),
    });
    this.analysisApi.runDetail(this.accountId, this.runId).subscribe({
      next: (out) => {
        this.run.set(out.run);
        this.recommendations.set(out.recommendations);
        this.campaigns.set(out.campaigns);
        this.isLatest.set(out.isLatest);
        this.loading.set(false);
      },
      error: () => {
        if (this.destroyed) return;
        this.run.set(null);
        this.loading.set(false);
      },
    });
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
