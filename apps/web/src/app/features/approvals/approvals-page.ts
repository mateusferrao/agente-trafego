import { ChangeDetectionStrategy, Component, type OnInit, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { toast } from 'ngx-sonner';
import { NumberStepper, UiButton, UiConfirmDialogService, UiEmptyState, UiEyebrow, UiInput, UiPageHeader } from '@ui';
import { DraftEditPanel } from './draft-edit-panel';
import { GeoAudienceEditor, KM, type ExplicitAudienceState } from './geo-audience-editor';
import { AnalysisApiService } from '@core/api/analysis-api.service';
import { ApprovalsApiService } from '@core/api/approvals-api.service';
import { DraftsApiService } from '@core/api/drafts-api.service';
import { AGENT_NAME } from '@core/brand';
import type { ApprovalOutput, DraftApprovalOutput, RevertibleActionOutput } from '@core/api/generated';
import { UNDO_WARNING, actionTypeLabel, deadlineText, entityTargetLabel } from '@app/shared/action-format';
import { conversionLabel } from '@app/shared/conversion-label';
import { currencySymbol, money } from '@app/shared/format';

interface AccountGroup<T> {
  readonly accountId: string;
  readonly accountName: string;
  readonly items: readonly T[];
}

/** Agrupa por conta (caixa de entrada legível p/ gestor multi-conta) — genérico:
 *  serve tanto pendentes (ApprovalOutput) quanto revertíveis (RevertibleActionOutput). */
function groupByAccount<T extends { accountId: string; accountName: string }>(
  rows: readonly T[],
): AccountGroup<T>[] {
  const byId = new Map<string, AccountGroup<T> & { items: T[] }>();
  for (const r of rows) {
    const g = byId.get(r.accountId);
    if (g) g.items.push(r);
    else byId.set(r.accountId, { accountId: r.accountId, accountName: r.accountName, items: [r] });
  }
  return [...byId.values()];
}

/**
 * Aprovações = ações que aguardam o OK humano (HITL — CLAUDE.md §7/§8) + ações já
 * aplicadas que ainda podem ser revertidas (dentro do TTL) — cross-conta, duas
 * seções empilhadas. Reverter aqui usa a mesma rota por-conta da mini-surface.
 */
@Component({
  selector: 'app-approvals-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, UiEmptyState, UiPageHeader, UiButton, UiEyebrow, UiInput, NumberStepper, DraftEditPanel, GeoAudienceEditor],
  template: `
    <div class="flex flex-col gap-8">
      <app-ui-page-header
        title="Aprovações"
        subtitle="Ações que aguardam seu OK ou que ainda podem ser revertidas."
      />

      @if (loaded() && pendingGroups().length === 0 && revertibleGroups().length === 0 && draftGroups().length === 0) {
        <app-ui-empty-state
          brand
          title="Nada aguardando OK nem revertível"
          [description]="emptyDescription"
        />
      } @else {
        @if (draftGroups().length > 0) {
          <section class="flex flex-col gap-4">
            <h1 class="font-brand text-base font-semibold text-ink">Rascunhos de campanha</h1>
            @for (group of draftGroups(); track group.accountId) {
              <div class="flex flex-col gap-3">
                <h2 class="font-brand text-sm font-semibold text-ink">{{ group.accountName }}</h2>
                <ul class="flex flex-col gap-2">
                  @for (d of group.items; track d.id) {
                    <li class="ui-panel-card--brand flex flex-col gap-3">
                      <span class="flex flex-col gap-1">
                        <app-ui-eyebrow>
                          {{ draftKindLabel(d) }}@if (d.origin === 'proactive') { · proposta do {{ agentName }}}@if (deadline(d.expiresAt); as dl) { · {{ dl }}}
                        </app-ui-eyebrow>
                        <span class="font-semibold text-ink">{{ draftTitle(d) }}</span>
                      </span>
                      <dl class="grid grid-cols-1 gap-1 text-sm text-ink sm:grid-cols-2">
                        <div><dt class="inline text-muted">{{ d.approvalKind === 'activation' ? 'Gasto' : 'Gasto novo' }}: </dt><dd class="inline font-semibold">{{ money(d.dailyBudgetMajor, d.currency) }}/dia</dd>@if (d.clampedFromMajor; as req) {<dd class="inline text-xs text-muted"> (você pediu {{ money(req, d.currency) }} — cortei pro seu teto)</dd>}</div>
                        <div><dt class="inline text-muted">Status: </dt><dd class="inline">{{ activationStatusText(d) }}</dd></div>
                        @if (d.pageId) { <div><dt class="inline text-muted">Página: </dt><dd class="inline">conectada</dd></div> }
                        @if (d.pixelId) { <div><dt class="inline text-muted">Rastreamento: </dt><dd class="inline">pixel conectado</dd></div> }
                        @if (d.objective) { <div><dt class="inline text-muted">Objetivo: </dt><dd class="inline">{{ objectiveLabel(d.objective) }}</dd></div> }
                        @if (d.sourceLevel) { <div><dt class="inline text-muted">Origem: </dt><dd class="inline">{{ sourceName(d) }}</dd></div> }
                      </dl>
                      @if (d.audience; as aud) {
                        <div class="text-sm text-ink">
                          <span class="text-muted">Público: </span>{{ aud === 'reuse' ? 'herda o que já converte' : 'a Meta escolhe (mais amplo)' }}
                        </div>
                      }
                      @if (d.copyVariants && d.copyVariants.length > 0) {
                        <ul class="flex flex-col gap-2">
                          @for (c of d.copyVariants; track $index) {
                            <li class="flex gap-3 rounded-lg border border-line bg-panel px-3 py-2 text-sm">
                              @if (!thumbBroken().has(adKey(d.id, $index))) {
                                <img
                                  [src]="adThumbUrl(d, $index)"
                                  (error)="onAdThumbError(d.id, $index)"
                                  alt="Prévia do criativo do anúncio"
                                  class="h-14 w-14 shrink-0 rounded-md border border-line object-cover"
                                />
                              } @else {
                                <span class="flex h-14 w-14 shrink-0 items-center justify-center rounded-md border border-line text-center text-xs text-muted">sem prévia</span>
                              }
                              <span class="min-w-0 flex-1">
                                <span class="block font-semibold text-ink">{{ c.headline }}</span>
                                <span class="block text-muted">{{ c.primaryText }}</span>
                                @if (c.creative; as cr) { <span class="block text-xs text-muted">{{ creativeLabel(cr) }}</span> }
                              </span>
                            </li>
                          }
                        </ul>
                      }
                      <div class="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-end">
                        @if (d.approvalKind === 'draft') {
                          <button appButton variant="ghost" size="sm" class="sm:mr-auto" [disabled]="resolving().has(d.id)" (click)="toggleEdit(d)">
                            {{ editingFor() === d.id ? 'Fechar edição' : 'Editar' }}
                          </button>
                        }
                        <div class="flex gap-2">
                          <button appButton variant="secondary" size="sm" class="flex-1 sm:flex-none" [disabled]="resolving().has(d.id)" (click)="rejectDraft(d)">
                            {{ d.approvalKind === 'activation' ? 'Deixar pausada' : 'Recusar' }}
                          </button>
                          <button appButton size="sm" class="flex-1 sm:flex-none" [disabled]="resolving().has(d.id)" (click)="approveDraft(d)">
                            {{ resolving().has(d.id) ? 'Enviando…' : (d.approvalKind === 'activation' ? 'Ativar' : 'Aprovar') }}
                          </button>
                        </div>
                      </div>
                    </li>
                    @if (editingFor() === d.id) {
                      <li>
                        <app-draft-edit-panel
                          [draft]="d"
                          (saved)="onDraftSaved()"
                          (creativeChanged)="onDraftCreativeChanged(d)"
                          (close)="editingFor.set(null)"
                        />
                      </li>
                    }
                  }
                </ul>
              </div>
            }
          </section>
        }

        @if (pendingGroups().length > 0) {
          <section class="flex flex-col gap-4">
            <h1 class="font-brand text-base font-semibold text-ink">Aguardando OK</h1>
            @for (group of pendingGroups(); track group.accountId) {
              <div class="flex flex-col gap-3">
                <h2 class="font-brand text-sm font-semibold text-ink">{{ group.accountName }}</h2>
                <ul class="flex flex-col gap-2">
                  @for (a of group.items; track a.id) {
                    <li class="ui-panel-card--brand flex flex-col gap-3">
                      <div class="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                        <span class="flex min-w-0 flex-col gap-1">
                          <app-ui-eyebrow>Aguardando seu OK@if (deadline(a.expiresAt); as d) { · {{ d }}}</app-ui-eyebrow>
                          <span class="font-semibold text-ink">
                            {{ typeLabel(a.type) }} {{ pendingTargetOf(a) }}
                          </span>
                          <span class="text-xs text-muted">{{ a.reason }}</span>
                          @if (budgetLine(a); as bl) {
                            <span class="text-xs font-medium text-ink">{{ bl }}</span>
                          }
                        </span>
                        <span class="flex shrink-0 gap-2">
                          @if (a.type === 'adjust_budget') {
                            <button appButton variant="ghost" size="sm" [disabled]="resolving().has(a.id)" (click)="toggleEditAction(a)">
                              {{ editingActionId() === a.id ? 'Cancelar' : 'Editar valor' }}
                            </button>
                          }
                          @if (a.type === 'adjust_audience' && a.audience) {
                            <button appButton variant="ghost" size="sm" [disabled]="resolving().has(a.id)" (click)="toggleEditAudience(a)">
                              {{ editingAudienceId() === a.id ? 'Fechar edição' : 'Editar público' }}
                            </button>
                          }
                          <button appButton variant="secondary" size="sm" [disabled]="resolving().has(a.id)" (click)="reject(a)">
                            Rejeitar
                          </button>
                          <button appButton size="sm" [disabled]="resolving().has(a.id)" (click)="approve(a)">
                            {{ resolving().has(a.id) ? 'Enviando…' : 'Aprovar' }}
                          </button>
                        </span>
                      </div>
                      @if (editingActionId() === a.id) {
                        <div class="flex flex-col gap-2 border-t border-line pt-3">
                          <div class="flex flex-col gap-2 sm:flex-row sm:items-end">
                            <label class="flex flex-1 flex-col gap-1 text-sm">
                              <span class="text-muted">Novo orçamento diário ({{ currencySymbol(a.currency) }})</span>
                              <input
                                appInput
                                appNumberStepper
                                type="number"
                                inputmode="decimal"
                                min="1"
                                step="1"
                                [ngModel]="editBudgetReais()"
                                (ngModelChange)="editBudgetReais.set($event)"
                              />
                            </label>
                            <button appButton size="sm" [disabled]="savingAction()" (click)="saveActionEdit(a)">
                              {{ savingAction() ? 'Salvando…' : 'Salvar valor' }}
                            </button>
                          </div>
                          <p class="text-xs text-muted">Ajusto o valor; aprovar em seguida aplica com o número novo (respeitando seu teto).</p>
                        </div>
                      }
                      @if (editingAudienceId() === a.id && a.audience) {
                        <div class="flex flex-col gap-3 border-t border-line pt-3">
                          <p class="rounded-md border-2 border-warning bg-warning-soft px-3 py-2 text-xs text-ink">
                            Editar o público reinicia o aprendizado da Meta nesse conjunto — a entrega pode oscilar por alguns dias até reestabilizar. Ajuste com calma antes de aprovar.
                          </p>
                          <app-geo-audience-editor
                            [accountId]="a.accountId"
                            [initial]="audienceSeed(a)"
                            (stateChange)="audienceState.set($event)"
                          />
                          <div class="flex justify-end gap-2">
                            <button appButton variant="secondary" size="sm" [disabled]="savingAudience()" (click)="editingAudienceId.set(null)">Cancelar</button>
                            <button appButton size="sm" [disabled]="savingAudience()" (click)="saveAudienceEdit(a)">
                              {{ savingAudience() ? 'Salvando…' : 'Salvar público' }}
                            </button>
                          </div>
                        </div>
                      }
                    </li>
                  }
                </ul>
              </div>
            }
          </section>
        }

        @if (revertibleGroups().length > 0) {
          <section class="flex flex-col gap-4">
            <h1 class="font-brand text-base font-semibold text-ink">Reversíveis</h1>
            @for (group of revertibleGroups(); track group.accountId) {
              <div class="flex flex-col gap-3">
                <h2 class="font-brand text-sm font-semibold text-ink">{{ group.accountName }}</h2>
                <ul class="flex flex-col gap-2">
                  @for (a of group.items; track a.toolCallId) {
                    <li class="flex flex-col gap-3 rounded-lg border border-line bg-panel px-4 py-3 sm:flex-row sm:items-start sm:justify-between">
                      <span class="flex min-w-0 flex-col gap-1">
                        <app-ui-eyebrow>Reversível</app-ui-eyebrow>
                        <span class="font-semibold text-ink">
                          {{ typeLabel(a.type) }} {{ revertibleTargetOf(a) }}
                        </span>
                        @if (a.revertBlocked && a.revertBlockedReason) {
                          <span class="text-xs text-muted">Não revertida: {{ a.revertBlockedReason }}</span>
                        }
                      </span>
                      @if (isCreation(a)) {
                        <span class="flex shrink-0 flex-col items-stretch gap-1 sm:items-end">
                          <span class="flex gap-2">
                            <button appButton variant="secondary" size="sm" [disabled]="reverting().has(a.toolCallId)" (click)="revert(a, false, 'pause')">
                              {{ reverting().has(a.toolCallId) ? 'Pausando…' : 'Pausar a campanha criada' }}
                            </button>
                            <button appButton variant="ghost" size="sm" [disabled]="reverting().has(a.toolCallId)" (click)="archiveCreation(a)">Arquivar</button>
                          </span>
                          <span class="text-[11px] text-muted">Pausar mantém a campanha na conta (não gasta, dá pra reativar). Arquivar tira da lista ativa (recuperável).</span>
                        </span>
                      } @else if (a.revertBlocked) {
                        <button appButton variant="secondary" size="sm" [disabled]="reverting().has(a.toolCallId)" (click)="revert(a, true)">
                          {{ reverting().has(a.toolCallId) ? 'Revertendo…' : 'Reverter mesmo assim' }}
                        </button>
                      } @else if (a.undoable) {
                        <button appButton variant="secondary" size="sm" [disabled]="reverting().has(a.toolCallId)" (click)="revert(a)">
                          {{ reverting().has(a.toolCallId) ? 'Revertendo…' : 'Reverter' }}
                        </button>
                      }
                    </li>
                  }
                </ul>
              </div>
            }
          </section>
        }
      }
    </div>
  `,
})
export class ApprovalsPage implements OnInit {
  // Marca: 1ª menção do agente apresenta o Roy (aposto).
  protected readonly emptyDescription = `Quando o ${AGENT_NAME}, seu agente de tráfego, propuser mudanças ou aplicar algo que ainda dá pra desfazer, aparece aqui.`;
  protected readonly agentName = AGENT_NAME;
  private readonly api = inject(ApprovalsApiService);
  private readonly draftsApi = inject(DraftsApiService);
  private readonly analysisApi = inject(AnalysisApiService);
  private readonly confirmDialog = inject(UiConfirmDialogService);

  protected readonly pendingGroups = signal<readonly AccountGroup<ApprovalOutput>[]>([]);
  protected readonly revertibleGroups = signal<readonly AccountGroup<RevertibleActionOutput>[]>([]);
  protected readonly draftGroups = signal<readonly AccountGroup<DraftApprovalOutput>[]>([]);
  private readonly pendingLoaded = signal(false);
  private readonly revertibleLoaded = signal(false);
  private readonly draftsLoaded = signal(false);
  protected readonly loaded = computed(
    () => this.pendingLoaded() && this.revertibleLoaded() && this.draftsLoaded(),
  );
  protected readonly resolving = signal<ReadonlySet<string>>(new Set());
  protected readonly reverting = signal<ReadonlySet<string>>(new Set());
  /** id da ação com o editor de valor aberto (C — só adjust_budget, 1 por vez) + estado do form. */
  protected readonly editingActionId = signal<string | null>(null);
  protected readonly editBudgetReais = signal<number | null>(null);
  protected readonly savingAction = signal(false);
  /** id da ação adjust_audience com o editor de PÚBLICO aberto (Fatia C, 1 por vez) + estado do editor. */
  protected readonly editingAudienceId = signal<string | null>(null);
  protected readonly audienceState = signal<ExplicitAudienceState | null>(null);
  protected readonly savingAudience = signal(false);
  /** id do rascunho com o painel "Editar rascunho" aberto (só 1 por vez). */
  protected readonly editingFor = signal<string | null>(null);
  /** ids de rascunho cuja miniatura falhou (reuse fbcdn/Meta indisponível) → placeholder. */
  protected readonly thumbBroken = signal<ReadonlySet<string>>(new Set());
  /** versão da miniatura por rascunho — bumpa após trocar o criativo (cache-buster da img). */
  protected readonly thumbVersion = signal<ReadonlyMap<string, number>>(new Map());

  /** chave da miniatura POR ANÚNCIO (G) — o card mostra 1 preview por anúncio, não o geral. */
  protected adKey = (draftId: string, index: number): string => `${draftId}:${index}`;
  protected adThumbUrl = (d: DraftApprovalOutput, index: number): string =>
    this.draftsApi.draftAdCreativeThumbUrl(d.accountId, d.draftId, index, this.thumbVersion().get(d.id) ?? 0);
  protected onAdThumbError(draftId: string, index: number): void {
    this.thumbBroken.update((s) => new Set(s).add(this.adKey(draftId, index)));
  }
  /** rótulo do criativo (formato + origem) — sem jargão, sem citar id técnico. */
  protected creativeLabel = (cr: NonNullable<DraftApprovalOutput['creative']>): string => {
    const fmt = cr.format === 'video' ? 'vídeo' : 'imagem';
    return `${fmt} · ${cr.origin === 'reuse' ? 'reusado de um anúncio da conta' : 'da sua biblioteca'}`;
  };

  protected typeLabel = actionTypeLabel;
  protected deadline = deadlineText;
  protected pendingTargetOf = (a: ApprovalOutput): string =>
    entityTargetLabel(a.entityLevel, a.entityId, a.entityName);
  protected revertibleTargetOf = (a: RevertibleActionOutput): string =>
    entityTargetLabel(a.targetLevel, a.targetId, a.targetName);

  protected draftKindLabel = (d: DraftApprovalOutput): string => {
    if (d.approvalKind === 'activation') return 'Pronta pra ativar';
    return d.kind === 'duplicate' ? 'Escalar vencedor' : 'Criar campanha';
  };
  protected draftTitle = (d: DraftApprovalOutput): string =>
    d.kind === 'duplicate'
      ? `Duplicar ${this.sourceName(d)} com mais budget`
      : `Nova campanha${d.objective ? ` de ${conversionLabel(d.objective)}` : ''}`;
  /** P0.1: a criação SEMPRE nasce pausada — o card diz isso com honestidade em vez de prometer
   *  "ativa" antes de existir o 2º OK. */
  protected activationStatusText = (d: DraftApprovalOutput): string => {
    if (d.approvalKind === 'activation') return 'criada e PAUSADA — aguardando seu OK pra ativar';
    return d.activation === 'active' ? 'nasce pausada — você confirma a ativação em seguida' : 'fica pausada (você pediu assim)';
  };
  /** Origem legível: "conjunto <nome>" quando há nome; senão "o conjunto vencedor" (nunca o id
   *  cru da Meta). O nível vira palavra amigável (adset→conjunto). */
  protected sourceName = (d: DraftApprovalOutput): string => {
    const lvl = d.sourceLevel === 'campaign' ? 'campanha' : d.sourceLevel === 'adset' ? 'conjunto' : d.sourceLevel === 'ad' ? 'anúncio' : '';
    if (d.sourceName) return lvl ? `${lvl} ${d.sourceName}` : d.sourceName;
    return lvl ? `o ${lvl} vencedor` : 'o vencedor';
  };
  protected objectiveLabel = (o: string | null): string => (o ? conversionLabel(o) : '');
  protected money = money;
  protected currencySymbol = currencySymbol;

  /** Contexto de orçamento do card (só adjust_budget com atual conhecido): "atual X → proposto Y"
   *  — dá base pro usuário aprovar/ajustar com mais informação (a projeção respeita o teto no apply).
   *  Sem sufixo de período: o valor pode ser diário OU vitalício (o motivo já esclarece qual). */
  protected budgetLine(a: ApprovalOutput): string | null {
    if (a.type !== 'adjust_budget' || a.currentBudgetMajor == null) return null;
    const atual = `orçamento atual ${money(a.currentBudgetMajor, a.currency)}`;
    if (a.targetBudgetMajor == null) return atual;
    return `${atual} → proposto ${money(a.targetBudgetMajor, a.currency)}`;
  }

  ngOnInit(): void {
    this.api.listPending().subscribe({
      next: (rows) => {
        this.pendingGroups.set(groupByAccount(rows));
        this.pendingLoaded.set(true);
      },
      error: () => this.pendingLoaded.set(true),
    });
    this.api.listRevertible().subscribe({
      next: (rows) => {
        this.revertibleGroups.set(groupByAccount(rows));
        this.revertibleLoaded.set(true);
      },
      error: () => this.revertibleLoaded.set(true),
    });
    this.draftsApi.listPending().subscribe({
      next: (rows) => {
        this.draftGroups.set(groupByAccount(rows));
        this.draftsLoaded.set(true);
      },
      error: () => this.draftsLoaded.set(true),
    });
  }

  /** Aprovar rascunho (criação) OU confirmar ativação (P0.1) — mesma rota resolve
   *  (kind-agnóstica no backend). Otimista. */
  protected approveDraft(d: DraftApprovalOutput): void {
    this.markResolving(d.id);
    this.api.resolve(d.id, 'approve').subscribe({
      next: () => {
        this.removeDraft(d.id);
        toast.success(d.approvalKind === 'activation' ? 'Ativando. Já deve estar veiculando.' : `Enviado pra criação. O ${AGENT_NAME} cria em instantes.`);
      },
      error: () => this.clearResolving(d.id),
    });
  }

  /** Recusar a criação (nada é criado) OU manter pausada (P0.1 — a campanha já criada não é
   *  desfeita, só segue sem ativar). */
  protected rejectDraft(d: DraftApprovalOutput): void {
    this.markResolving(d.id);
    this.api.resolve(d.id, 'reject').subscribe({
      next: () => {
        this.removeDraft(d.id);
        toast.success(d.approvalKind === 'activation' ? 'Tudo bem, ela continua pausada.' : 'Descartei o rascunho.');
      },
      error: () => this.clearResolving(d.id),
    });
  }

  /** O painel trocou o criativo (ação imediata) — atualiza a miniatura (cache-buster) e recarrega
   *  a lista SEM fechar o painel (o usuário segue editando; o rótulo/thumb refletem o novo). */
  protected onDraftCreativeChanged(d: DraftApprovalOutput): void {
    this.bumpThumbVersion(d.id);
    this.clearThumbBroken(d.id);
    this.reloadDrafts();
  }

  private bumpThumbVersion(id: string): void {
    this.thumbVersion.update((m) => new Map(m).set(id, (m.get(id) ?? 0) + 1));
  }
  private clearThumbBroken(id: string): void {
    // as chaves de miniatura quebrada são POR ANÚNCIO (`${draftId}:${index}`) — limpa TODAS as do
    // rascunho pra o refetch (após trocar criativo) reatentar cada anúncio.
    const prefix = `${id}:`;
    this.thumbBroken.update((s) => new Set([...s].filter((k) => !k.startsWith(prefix))));
  }
  /** Abre/fecha o painel de edição do rascunho (fecha o picker se estava aberto). */
  protected toggleEdit(d: DraftApprovalOutput): void {
    this.editingFor.update((cur) => (cur === d.id ? null : d.id));
  }
  /** O painel salvou → recarrega os rascunhos (reflete nomes/gasto/copy frescos) e fecha. */
  protected onDraftSaved(): void {
    this.editingFor.set(null);
    this.reloadDrafts();
  }

  /** Recarrega os rascunhos pendentes (rótulo do criativo/público fresco após uma troca). */
  private reloadDrafts(): void {
    this.draftsApi.listPending().subscribe({
      next: (rows) => this.draftGroups.set(groupByAccount(rows)),
    });
  }

  private removeDraft(id: string): void {
    this.draftGroups.update((gs) =>
      gs.map((g) => ({ ...g, items: g.items.filter((x) => x.id !== id) })).filter((g) => g.items.length > 0),
    );
    this.clearResolving(id);
  }

  /** Aprovar: enfileira a aplicação (worker re-checa fresco + aplica). Otimista. */
  protected approve(a: ApprovalOutput): void {
    this.markResolving(a.id);
    this.api.resolve(a.id, 'approve').subscribe({
      next: () => {
        this.removePending(a.id);
        toast.success(`Aprovado. O ${AGENT_NAME} aplica em instantes.`);
      },
      error: () => this.clearResolving(a.id),
    });
  }

  /** Rejeitar: descarta a sugestão (nada é aplicado na Meta). */
  protected reject(a: ApprovalOutput): void {
    this.markResolving(a.id);
    this.api.resolve(a.id, 'reject').subscribe({
      next: () => {
        this.removePending(a.id);
        toast.success('Descartei a sugestão.');
      },
      error: () => this.clearResolving(a.id),
    });
  }

  /** Abre/fecha o editor de valor de uma ação adjust_budget (C). Ao abrir, pré-preenche com o
   *  valor PROPOSTO (senão o atual) — o usuário parte do número sugerido em vez de um campo vazio. */
  protected toggleEditAction(a: ApprovalOutput): void {
    const opening = this.editingActionId() !== a.id;
    this.editingActionId.set(opening ? a.id : null);
    this.editBudgetReais.set(opening ? (a.targetBudgetMajor ?? a.currentBudgetMajor ?? null) : null);
  }

  /** Salva o novo VALOR (R$/dia, mode "set") da ação pendente antes de aprovar (C). A ação segue
   *  pendente; aprovar em seguida aplica com o valor novo (o guardrail fresco clampa se estourar). */
  protected saveActionEdit(a: ApprovalOutput): void {
    const reais = this.editBudgetReais();
    if (reais == null || !(reais > 0)) {
      toast.error('O valor precisa ser maior que zero.');
      return;
    }
    this.savingAction.set(true);
    this.api.editAction(a.id, { mode: 'set', budgetReais: reais }).subscribe({
      next: () => {
        this.savingAction.set(false);
        this.editingActionId.set(null);
        toast.success('Valor atualizado. Agora é só aprovar.');
        // recarrega pra o card refletir o novo "proposto" (senão fica o valor velho até dar F5).
        this.reloadPending();
      },
      error: () => this.savingAction.set(false),
    });
  }

  /** Público proposto (API) → estado do editor (`GeoAudienceEditor`). Semente da edição. */
  protected audienceSeed(a: ApprovalOutput): ExplicitAudienceState {
    const au = a.audience!;
    return {
      geo: au.geo.map((g) => ({ key: g.key, name: g.name, kind: g.kind, radius: g.radius, distanceUnit: g.distanceUnit })),
      radiusAreas: au.radiusAreas.map((r) => ({ address: r.address, radius: r.radius, distanceUnit: r.distanceUnit })),
      ageMin: au.ageMin,
      ageMax: au.ageMax,
      genders: au.genders,
      interestGroups: au.interestGroups.map((grp) => grp.map((i) => ({ id: i.id, name: i.name }))),
      behaviorGroups: au.behaviorGroups.map((grp) => grp.map((b) => ({ id: b.id, name: b.name }))),
      customAudienceIncludeIds: [...au.customAudienceIncludeIds],
      customAudienceExcludeIds: [...au.customAudienceExcludeIds],
    };
  }

  /** Abre/fecha o editor de público de uma ação adjust_audience (Fatia C). Semeia o estado com o
   *  público PROPOSTO (o editor emite o completo a cada mudança). */
  protected toggleEditAudience(a: ApprovalOutput): void {
    const opening = this.editingAudienceId() !== a.id;
    this.editingAudienceId.set(opening ? a.id : null);
    this.audienceState.set(opening ? this.audienceSeed(a) : null);
  }

  /** Salva o público editado (substituição total) antes de aprovar (Fatia C). A ação segue pendente;
   *  aprovar em seguida aplica o público novo (o apply re-checa fresco). */
  protected saveAudienceEdit(a: ApprovalOutput): void {
    const state = this.audienceState();
    if (!state) return;
    if (state.geo.length === 0 && state.radiusAreas.length === 0 && !state.ageMin && !state.ageMax && (state.genders?.length ?? 0) === 0 && state.interestGroups.length === 0 && state.behaviorGroups.length === 0 && state.customAudienceIncludeIds.length === 0 && state.customAudienceExcludeIds.length === 0) {
      toast.error('Escolha ao menos um critério de público (local, idade, interesse ou público salvo).');
      return;
    }
    this.savingAudience.set(true);
    this.api.editAction(a.id, { explicitAudience: this.toExplicitAudienceInput(state) }).subscribe({
      next: () => {
        this.savingAudience.set(false);
        this.editingAudienceId.set(null);
        toast.success('Público atualizado. Agora é só aprovar.');
        this.reloadPending();
      },
      error: () => this.savingAudience.set(false),
    });
  }

  /** Estado do editor → input de substituição total do público (keys/ids já resolvidos). Espelha o
   *  `toExplicitInput` do painel de rascunho — radius/distanceUnit só quando houver. */
  private toExplicitAudienceInput(s: ExplicitAudienceState): NonNullable<Parameters<ApprovalsApiService['editAction']>[1]['explicitAudience']> {
    return {
      geo: s.geo.map((g) => ({
        key: g.key,
        name: g.name,
        kind: g.kind,
        ...(g.radius != null ? { radius: g.radius, distanceUnit: g.distanceUnit ?? KM } : {}),
      })),
      radiusAreas: s.radiusAreas.map((a) => ({ address: a.address, radius: a.radius, distanceUnit: a.distanceUnit })),
      ...(s.ageMin != null ? { ageMin: s.ageMin } : {}),
      ...(s.ageMax != null ? { ageMax: s.ageMax } : {}),
      ...(s.genders ? { genders: [...s.genders] } : {}),
      interestGroups: s.interestGroups.map((g) => g.map((i) => ({ id: i.id, name: i.name }))),
      behaviorGroups: s.behaviorGroups.map((g) => g.map((i) => ({ id: i.id, name: i.name }))),
      customAudienceIncludeIds: [...s.customAudienceIncludeIds],
      customAudienceExcludeIds: [...s.customAudienceExcludeIds],
    };
  }

  /** Recarrega as pendentes (reflete o novo valor proposto no card após editar). */
  private reloadPending(): void {
    this.api.listPending().subscribe({
      next: (rows) => this.pendingGroups.set(groupByAccount(rows)),
    });
  }

  /** Item reversível é uma CRIAÇÃO/escala? (teardown pausa/arquiva a árvore, não "reverte" estado). */
  protected isCreation = (a: RevertibleActionOutput): boolean =>
    a.type === 'create_campaign' || a.type === 'duplicate_scale';

  /** Arquivar a campanha criada (destrutivo-leve — confirma antes). */
  protected async archiveCreation(a: RevertibleActionOutput): Promise<void> {
    const confirmed = await this.confirmDialog.confirm({
      title: 'Arquivar a campanha criada?',
      description: 'Arquivar tira a campanha da sua lista ativa na Meta. Ela não é apagada e dá pra recuperar, mas some da visão do dia a dia.',
      confirmLabel: 'Arquivar',
      tone: 'warning',
    });
    if (!confirmed) return;
    this.runRevert(a, false, 'archive', 'Arquivando a campanha criada.');
  }

  /** Reverter (por-conta, mesma rota da mini-surface). `force` = "mesmo assim" após drift;
   *  `mode` = pausar/arquivar quando é uma criação/escala. */
  protected async revert(a: RevertibleActionOutput, force = false, mode?: 'pause' | 'archive'): Promise<void> {
    if (this.isCreation(a) && mode === 'pause') {
      // pausar é seguro/reversível — sem diálogo, ação direta.
      this.runRevert(a, false, 'pause', 'Pausando a campanha criada.');
      return;
    }
    const description = force && a.revertBlockedReason ? `${a.revertBlockedReason}. ${UNDO_WARNING}` : UNDO_WARNING;
    const confirmed = await this.confirmDialog.confirm({
      title: force ? 'Reverter mesmo assim?' : 'Reverter ação?',
      description,
      confirmLabel: 'Reverter',
      tone: 'warning',
    });
    if (!confirmed) return;
    this.runRevert(a, force, mode, 'Revertendo. A ação volta ao estado anterior.');
  }

  private runRevert(a: RevertibleActionOutput, force: boolean, mode: 'pause' | 'archive' | undefined, successMsg: string): void {
    this.markReverting(a.toolCallId);
    this.analysisApi.undoAction(a.accountId, a.toolCallId, force, mode).subscribe({
      next: () => {
        this.removeRevertible(a.toolCallId);
        toast.success(successMsg);
      },
      error: () => this.clearReverting(a.toolCallId),
    });
  }

  private removePending(id: string): void {
    this.pendingGroups.update((gs) =>
      gs.map((g) => ({ ...g, items: g.items.filter((x) => x.id !== id) })).filter((g) => g.items.length > 0),
    );
    this.clearResolving(id);
  }

  private removeRevertible(toolCallId: string): void {
    this.revertibleGroups.update((gs) =>
      gs
        .map((g) => ({ ...g, items: g.items.filter((x) => x.toolCallId !== toolCallId) }))
        .filter((g) => g.items.length > 0),
    );
    this.clearReverting(toolCallId);
  }

  private markResolving(id: string): void {
    this.resolving.update((s) => new Set(s).add(id));
  }

  private clearResolving(id: string): void {
    this.resolving.update((s) => {
      const next = new Set(s);
      next.delete(id);
      return next;
    });
  }

  private markReverting(id: string): void {
    this.reverting.update((s) => new Set(s).add(id));
  }

  private clearReverting(id: string): void {
    this.reverting.update((s) => {
      const next = new Set(s);
      next.delete(id);
      return next;
    });
  }
}
