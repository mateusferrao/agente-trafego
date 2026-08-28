import { ChangeDetectionStrategy, Component, type OnInit, computed, inject, signal } from '@angular/core';
import { toast } from 'ngx-sonner';
import { UiButton, UiConfirmDialogService, UiEmptyState, UiEyebrow, UiPageHeader } from '@ui';
import { CreativePicker } from './creative-picker';
import { DraftEditPanel } from './draft-edit-panel';
import { AnalysisApiService } from '@core/api/analysis-api.service';
import { ApprovalsApiService } from '@core/api/approvals-api.service';
import { DraftsApiService } from '@core/api/drafts-api.service';
import { AGENT_NAME } from '@core/brand';
import type { ApprovalOutput, DraftApprovalOutput, RevertibleActionOutput, SetDraftCreativeInput } from '@core/api/generated';
import { UNDO_WARNING, actionTypeLabel, deadlineText, entityTargetLabel } from '@app/shared/action-format';
import { conversionLabel } from '@app/shared/conversion-label';
import { money } from '@app/shared/format';

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
  imports: [UiEmptyState, UiPageHeader, UiButton, UiEyebrow, CreativePicker, DraftEditPanel],
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
                      @if (d.creative; as cr) {
                        <div class="flex items-center gap-3">
                          @if (!thumbBroken().has(d.id)) {
                            <img
                              [src]="thumbUrl(d)"
                              (error)="onThumbError(d.id)"
                              alt="Prévia do criativo"
                              class="h-16 w-16 shrink-0 rounded-lg border border-line object-cover"
                            />
                          } @else {
                            <span class="flex h-16 w-16 shrink-0 items-center justify-center rounded-lg border border-line text-xs text-muted">sem prévia</span>
                          }
                          <span class="text-sm text-ink"><span class="text-muted">Criativo: </span>{{ creativeLabel(cr) }}</span>
                        </div>
                      }
                      @if (d.audience; as aud) {
                        <div class="flex flex-col gap-1">
                          <span class="text-xs text-muted">Público</span>
                          <span class="flex flex-wrap gap-2">
                            <button appButton [variant]="aud === 'reuse' ? 'secondary' : 'ghost'" size="sm" [disabled]="settingAudience().has(d.id)" (click)="onSetAudience(d, 'reuse')">
                              Herda o que já converte
                            </button>
                            <button appButton [variant]="aud === 'broad' ? 'secondary' : 'ghost'" size="sm" [disabled]="settingAudience().has(d.id)" (click)="onSetAudience(d, 'broad')">
                              Deixa a Meta escolher
                            </button>
                          </span>
                        </div>
                      }
                      @if (d.copyVariants && d.copyVariants.length > 0) {
                        <ul class="flex flex-col gap-2">
                          @for (c of d.copyVariants; track $index) {
                            <li class="rounded-lg border border-line bg-panel px-3 py-2 text-sm">
                              <span class="block font-semibold text-ink">{{ c.headline }}</span>
                              <span class="block text-muted">{{ c.primaryText }}</span>
                            </li>
                          }
                        </ul>
                      }
                      <span class="flex shrink-0 flex-wrap gap-2">
                        @if (d.approvalKind === 'draft') {
                          <button appButton variant="ghost" size="sm" [disabled]="resolving().has(d.id)" (click)="toggleEdit(d)">
                            {{ editingFor() === d.id ? 'Fechar edição' : 'Editar' }}
                          </button>
                        }
                        @if (d.approvalKind === 'draft' && d.kind === 'from_scratch') {
                          <button appButton variant="ghost" size="sm" [disabled]="resolving().has(d.id)" (click)="togglePicker(d)">
                            {{ pickerFor() === d.id ? 'Cancelar troca' : 'Trocar criativo' }}
                          </button>
                        }
                        <button appButton variant="secondary" size="sm" [disabled]="resolving().has(d.id)" (click)="rejectDraft(d)">
                          {{ d.approvalKind === 'activation' ? 'Deixar pausada' : 'Recusar' }}
                        </button>
                        <button appButton size="sm" [disabled]="resolving().has(d.id)" (click)="approveDraft(d)">
                          {{ resolving().has(d.id) ? 'Enviando…' : (d.approvalKind === 'activation' ? 'Ativar' : 'Aprovar') }}
                        </button>
                      </span>
                    </li>
                    @if (pickerFor() === d.id) {
                      <li>
                        <app-creative-picker
                          [accountId]="d.accountId"
                          [picking]="pickingCreative()"
                          (pick)="onPickCreative(d, $event)"
                          (cancel)="pickerFor.set(null)"
                        />
                      </li>
                    }
                    @if (editingFor() === d.id) {
                      <li>
                        <app-draft-edit-panel [draft]="d" (saved)="onDraftSaved()" (close)="editingFor.set(null)" />
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
                    <li class="ui-panel-card--brand flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                      <span class="flex min-w-0 flex-col gap-1">
                        <app-ui-eyebrow>Aguardando seu OK@if (deadline(a.expiresAt); as d) { · {{ d }}}</app-ui-eyebrow>
                        <span class="font-semibold text-ink">
                          {{ typeLabel(a.type) }} {{ pendingTargetOf(a) }}
                        </span>
                        <span class="text-xs text-muted">{{ a.reason }}</span>
                      </span>
                      <span class="flex shrink-0 gap-2">
                        <button appButton variant="secondary" size="sm" [disabled]="resolving().has(a.id)" (click)="reject(a)">
                          Rejeitar
                        </button>
                        <button appButton size="sm" [disabled]="resolving().has(a.id)" (click)="approve(a)">
                          {{ resolving().has(a.id) ? 'Enviando…' : 'Aprovar' }}
                        </button>
                      </span>
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
  /** id do rascunho com o picker "trocar criativo" aberto (só 1 por vez). */
  protected readonly pickerFor = signal<string | null>(null);
  /** id do rascunho com o painel "Editar rascunho" aberto (só 1 por vez). */
  protected readonly editingFor = signal<string | null>(null);
  protected readonly pickingCreative = signal(false);
  /** ids de rascunho cuja miniatura falhou (reuse fbcdn/Meta indisponível) → placeholder. */
  protected readonly thumbBroken = signal<ReadonlySet<string>>(new Set());
  /** versão da miniatura por rascunho — bumpa após trocar o criativo (cache-buster da img). */
  protected readonly thumbVersion = signal<ReadonlyMap<string, number>>(new Map());

  protected thumbUrl = (d: DraftApprovalOutput): string =>
    this.draftsApi.draftCreativeThumbUrl(d.accountId, d.draftId, this.thumbVersion().get(d.id) ?? 0);
  protected onThumbError(id: string): void {
    this.thumbBroken.update((s) => new Set(s).add(id));
  }
  /** rótulo do criativo (formato + origem) — sem jargão, sem citar id técnico. */
  protected creativeLabel = (cr: NonNullable<DraftApprovalOutput['creative']>): string => {
    const fmt = cr.format === 'video' ? 'vídeo' : 'imagem';
    return `${fmt} · ${cr.origin === 'reuse' ? 'reusado de um anúncio da conta' : 'da sua biblioteca'}`;
  };

  /** rascunhos com a troca de público em voo (desabilita os botões). */
  protected readonly settingAudience = signal<ReadonlySet<string>>(new Set());
  /** Alterna o público do rascunho (reuse × amplo). Pessimista: desabilita os botões e só reflete
   *  a `audience` que o backend retornou (o backend pode negar reuse sem público provado). */
  protected onSetAudience(d: DraftApprovalOutput, audience: 'reuse' | 'broad'): void {
    if (d.audience === audience) return;
    this.settingAudience.update((s) => new Set(s).add(d.id));
    this.draftsApi.setDraftTargeting(d.accountId, d.draftId, { audience }).subscribe({
      next: (r) => {
        this.patchDraftAudience(d.id, r.audience);
        this.clearSettingAudience(d.id);
        toast.success(r.audience === 'reuse' ? 'Público: herda o que já converte.' : 'Público: a Meta escolhe (mais amplo).');
      },
      error: () => {
        this.clearSettingAudience(d.id);
        toast.error('Não consegui ajustar o público desse rascunho. Tente de novo.');
      },
    });
  }
  private patchDraftAudience(id: string, audience: 'reuse' | 'broad'): void {
    this.draftGroups.update((gs) =>
      gs.map((g) => ({ ...g, items: g.items.map((x) => (x.id === id ? { ...x, audience } : x)) })),
    );
  }
  private clearSettingAudience(id: string): void {
    this.settingAudience.update((s) => {
      const next = new Set(s);
      next.delete(id);
      return next;
    });
  }

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
        toast.success(d.approvalKind === 'activation' ? 'Ativando — já deve estar veiculando.' : 'Enviado para criação. O agente cria em instantes.');
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
        toast.success(d.approvalKind === 'activation' ? 'Tudo bem, ela continua pausada.' : 'Rascunho descartado');
      },
      error: () => this.clearResolving(d.id),
    });
  }

  /** Abre/fecha o picker de criativo pra um rascunho (só from_scratch). */
  protected togglePicker(d: DraftApprovalOutput): void {
    this.pickerFor.update((cur) => (cur === d.id ? null : d.id));
  }

  /** Troca o criativo do rascunho pela escolha do picker (biblioteca × reuse ao vivo). Ao trocar,
   *  atualiza o rótulo (recarrega a lista) E a miniatura (bumpa a versão = cache-buster da img). */
  protected onPickCreative(d: DraftApprovalOutput, choice: SetDraftCreativeInput): void {
    this.pickingCreative.set(true);
    this.draftsApi.setDraftCreative(d.accountId, d.draftId, choice).subscribe({
      next: () => {
        this.pickingCreative.set(false);
        this.pickerFor.set(null);
        this.bumpThumbVersion(d.id);
        this.clearThumbBroken(d.id);
        this.reloadDrafts();
        toast.success('Criativo trocado neste rascunho.');
      },
      error: () => {
        this.pickingCreative.set(false);
        toast.error('Não consegui trocar o criativo. Tente de novo.');
      },
    });
  }

  private bumpThumbVersion(id: string): void {
    this.thumbVersion.update((m) => new Map(m).set(id, (m.get(id) ?? 0) + 1));
  }
  private clearThumbBroken(id: string): void {
    this.thumbBroken.update((s) => {
      const next = new Set(s);
      next.delete(id);
      return next;
    });
  }
  /** Abre/fecha o painel de edição do rascunho (fecha o picker se estava aberto). */
  protected toggleEdit(d: DraftApprovalOutput): void {
    this.pickerFor.set(null);
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
        toast.success('Enviado para aplicação. O agente aplica em instantes.');
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
        toast.success('Sugestão descartada');
      },
      error: () => this.clearResolving(a.id),
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
    this.runRevert(a, false, 'archive', 'Arquivando a campanha criada');
  }

  /** Reverter (por-conta, mesma rota da mini-surface). `force` = "mesmo assim" após drift;
   *  `mode` = pausar/arquivar quando é uma criação/escala. */
  protected async revert(a: RevertibleActionOutput, force = false, mode?: 'pause' | 'archive'): Promise<void> {
    if (this.isCreation(a) && mode === 'pause') {
      // pausar é seguro/reversível — sem diálogo, ação direta.
      this.runRevert(a, false, 'pause', 'Pausando a campanha criada');
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
    this.runRevert(a, force, mode, 'Revertendo — a ação volta ao estado anterior');
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
