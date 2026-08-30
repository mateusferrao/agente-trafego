import { ChangeDetectionStrategy, Component, computed, inject, input, type OnInit, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { toast } from 'ngx-sonner';
import { UiButton, UiInput, UiSelectBox, UiToggleGroup, UiToggleGroupItem, type UiSelectOptionItem } from '@ui';
import { CreativePicker } from './creative-picker';
import { GeoAudienceEditor, type ExplicitAudienceState } from './geo-audience-editor';
import { DraftsApiService } from '@core/api/drafts-api.service';
import { CONVERSION_LABEL, conversionLabel } from '@app/shared/conversion-label';
import type { DraftApprovalOutput, SetDraftCreativeInput, UpdateDraftInput } from '@core/api/generated';

/** Uma variação de copy no formulário (espelho editável do `DraftApprovalOutput.copyVariants`). */
interface CopyForm {
  adName: string;
  headline: string;
  primaryText: string;
  description: string;
}

/** Um item de copy do rascunho (elemento do array de saída). */
type DraftCopy = NonNullable<DraftApprovalOutput['copyVariants']>[number];

/**
 * Painel "Editar rascunho" (Fatia 7, Slice 7) — o EDITOR COMPLETO no site. O card de /approvals
 * fica só-leitura + atalhos rápidos (público/criativo); tudo o mais mora aqui: nomes, gasto,
 * ativação, copy campo-a-campo, remover anúncio (criação) OU rótulo do sufixo (escala). Manda só
 * os campos ALTERADOS pro `PATCH` (núcleo `applyDraftEdit`). Objetivo + gerar copy por IA = 7b.
 */
@Component({
  selector: 'app-draft-edit-panel',
  standalone: true,
  imports: [FormsModule, UiButton, UiInput, UiSelectBox, UiToggleGroup, UiToggleGroupItem, CreativePicker, GeoAudienceEditor],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="flex flex-col gap-4 rounded-md border border-line bg-soft p-4">
      <div class="flex items-center justify-between">
        <span class="text-sm font-semibold text-ink">Editar rascunho</span>
        <button type="button" class="text-xs text-muted hover:text-ink" (click)="close.emit()">Fechar</button>
      </div>

      @if (isScale()) {
        <p class="rounded-md border border-line bg-panel px-3 py-2 text-xs text-muted">
          Você está escalando um vencedor. O agente reaproveita o público, o criativo e a copy que já
          estão funcionando — aqui você ajusta só o nome, o orçamento e quando ativar.
        </p>
      }

      <!-- Nomes (só criação) / sufixo (escala) -->
      @if (isScale()) {
        <label class="flex flex-col gap-1">
          <span class="text-xs font-medium text-ink">Rótulo do nome</span>
          <input appInput class="w-full" [(ngModel)]="suffixLabel" placeholder="escala" />
          <span class="text-[11px] text-muted">O nome fica “{{ sourceLabel() }} — {{ suffixLabel() || 'escala' }}”.</span>
        </label>
      } @else {
        <label class="flex flex-col gap-1">
          <span class="text-xs font-medium text-ink">Nome da campanha</span>
          <input appInput class="w-full" [(ngModel)]="campaignName" [placeholder]="derivedNamePlaceholder()" />
        </label>
        <label class="flex flex-col gap-1">
          <span class="text-xs font-medium text-ink">Nome do conjunto</span>
          <input appInput class="w-full" [(ngModel)]="adsetName" [placeholder]="derivedNamePlaceholder() + ' — conjunto'" />
        </label>
        <label class="flex flex-col gap-1">
          <span class="text-xs font-medium text-ink">Objetivo</span>
          <app-ui-select
            [options]="objectiveSelectOptions"
            [value]="objective()"
            placeholder="Selecione o objetivo"
            (valueChange)="objective.set($event)"
          />
          <span class="text-[11px] text-muted">Objetivos de venda/lead precisam do pixel configurado na conta.</span>
        </label>
      }

      <!-- Gasto + ativação (comuns) — empilha no mobile, lado a lado no desktop -->
      <div class="flex flex-col gap-4 sm:flex-row sm:items-start">
        <label class="flex flex-col gap-1 sm:flex-1">
          <span class="text-xs font-medium text-ink">Gasto por dia ({{ draft().currency }})</span>
          <input appInput class="w-full" type="number" min="1" step="1" [(ngModel)]="budget" />
        </label>
        <div class="flex flex-col gap-1 sm:flex-1">
          <span class="text-xs font-medium text-ink">Ao aprovar</span>
          <div
            appToggleGroup
            ngpToggleGroupType="single"
            layout="segmented"
            [columns]="2"
            aria-label="Ao aprovar"
            [ngpToggleGroupValue]="[activation()]"
            (ngpToggleGroupValueChange)="setActivation($event)"
          >
            <button appToggleGroupItem tone="accent" ngpToggleGroupItemValue="paused">Deixar pausada</button>
            <button appToggleGroupItem tone="accent" ngpToggleGroupItemValue="active">Ativar em seguida</button>
          </div>
        </div>
      </div>

      <!-- Público (só quando o rascunho carrega um público editável — some na escala) -->
      @if (draft().audience) {
        <div class="flex flex-col gap-1">
          <span class="text-xs font-medium text-ink">Público</span>
          <div
            appToggleGroup
            ngpToggleGroupType="single"
            layout="segmented"
            [columns]="2"
            aria-label="Público"
            [ngpToggleGroupValue]="[audience()]"
            (ngpToggleGroupValueChange)="setAudience($event)"
          >
            <button appToggleGroupItem tone="accent" ngpToggleGroupItemValue="reuse">Herda o que já converte</button>
            <button appToggleGroupItem tone="accent" ngpToggleGroupItemValue="broad">Deixa a Meta escolher</button>
          </div>
        </div>
      }

      <!-- Público EXPLÍCITO por primitivos (Fase 1, subfatia 3b) — geo/idade/gênero, só quando o
           rascunho já nasceu assim (chat ou criação anterior); trocar de modo é fora do painel. -->
      @if (draft().explicitAudience; as ea) {
        <app-geo-audience-editor
          [accountId]="draft().accountId"
          [initial]="{ geo: ea.geo, ageMin: ea.ageMin, ageMax: ea.ageMax, genders: ea.genders, interests: ea.interests }"
          (stateChange)="explicitAudienceState.set($event)"
        />
      }

      <!-- Criativo (troca imediata — biblioteca × anúncio ao vivo; só criação) -->
      @if (!isScale()) {
        <div class="flex flex-col gap-2">
          <span class="text-xs font-medium text-ink">Criativo</span>
          <div class="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <span class="text-sm text-ink"><span class="text-muted">Atual: </span>{{ creativeLabel() }}</span>
            <button
              appButton
              variant="ghost"
              size="sm"
              type="button"
              class="shrink-0 self-start whitespace-nowrap sm:self-auto"
              [disabled]="picking()"
              (click)="showPicker.set(!showPicker())"
            >
              {{ showPicker() ? 'Cancelar troca' : 'Trocar criativo' }}
            </button>
          </div>
          @if (showPicker()) {
            <app-creative-picker
              [accountId]="draft().accountId"
              [picking]="picking()"
              (pick)="onPick($event)"
              (cancel)="showPicker.set(false)"
            />
          }
        </div>
      }

      <!-- Copy por anúncio (só criação) -->
      @if (!isScale() && copies().length > 0) {
        <div class="flex flex-col gap-3">
          <span class="text-xs font-medium text-ink">Anúncios</span>
          @for (c of copies(); track $index) {
            <div class="flex flex-col gap-2 rounded-md border border-line bg-panel p-3">
              <div class="flex items-center justify-between">
                <span class="text-[11px] font-medium uppercase tracking-wide text-muted">Anúncio {{ $index + 1 }}</span>
                <button
                  type="button"
                  class="text-[11px] text-muted hover:text-ink disabled:opacity-40"
                  [disabled]="copies().length <= 1 || saving()"
                  (click)="removeAd($index)"
                >
                  Remover
                </button>
              </div>
              <input appInput class="w-full" [(ngModel)]="c.adName" placeholder="Nome do anúncio (opcional)" />
              <input appInput class="w-full" [(ngModel)]="c.headline" placeholder="Título" />
              <textarea [class]="fieldClasses" rows="2" [(ngModel)]="c.primaryText" placeholder="Texto principal"></textarea>
              <input appInput class="w-full" [(ngModel)]="c.description" placeholder="Descrição (opcional)" />
            </div>
          }
        </div>
      }

      <div class="flex justify-end gap-2">
        <button appButton variant="secondary" size="sm" [disabled]="saving()" (click)="close.emit()">Cancelar</button>
        <button appButton size="sm" [disabled]="saving()" (click)="save()">{{ saving() ? 'Salvando…' : 'Salvar' }}</button>
      </div>
    </div>
  `,
})
export class DraftEditPanel implements OnInit {
  private readonly api = inject(DraftsApiService);

  readonly draft = input.required<DraftApprovalOutput>();
  /** salvou os campos do formulário (o pai recarrega e FECHA o painel). */
  readonly saved = output<void>();
  /** trocou o criativo (ação imediata) — o pai recarrega e MANTÉM o painel aberto. */
  readonly creativeChanged = output<void>();
  readonly close = output<void>();

  protected readonly saving = signal(false);
  protected readonly campaignName = signal('');
  protected readonly adsetName = signal('');
  protected readonly objective = signal('');
  protected readonly suffixLabel = signal('');
  /** classes do `<textarea>` nativo (`appInput` só casa `<input>`), no visual do design system. */
  protected readonly fieldClasses =
    'w-full rounded-md border border-line bg-app px-3 py-2 text-sm text-ink transition hover:border-muted/60 focus:border-ink focus:outline-none';
  /** opções de objetivo (valor neutro + rótulo PT) — fonte única do frontend. `custom` fica de fora:
   *  não é um objetivo de criação escolhível manualmente (vem de conversão personalizada da conta). */
  protected readonly objectiveSelectOptions: readonly UiSelectOptionItem[] = Object.entries(CONVERSION_LABEL)
    .filter(([key]) => key !== 'custom')
    .map(([value, label]) => ({ value, label }));
  protected readonly budget = signal(0);
  protected readonly activation = signal<'active' | 'paused'>('paused');
  protected readonly audience = signal<'reuse' | 'broad'>('reuse');
  /** estado ATUAL do editor de público explícito (Fase 1, subfatia 3b) — atualizado a cada mudança
   *  no filho; comparado com `draft().explicitAudience` no diff do Salvar. `null` = sem esse campo. */
  protected readonly explicitAudienceState = signal<ExplicitAudienceState | null>(null);
  protected readonly copies = signal<CopyForm[]>([]);
  /** picker de criativo aberto dentro do painel + troca em voo. */
  protected readonly showPicker = signal(false);
  protected readonly picking = signal(false);

  protected readonly isScale = computed(() => this.draft().kind === 'duplicate');
  /** rótulo do criativo atual (formato + origem) — sem jargão, sem id técnico. */
  protected readonly creativeLabel = computed(() => {
    const cr = this.draft().creative;
    if (!cr) return 'nenhum criativo escolhido';
    const fmt = cr.format === 'video' ? 'vídeo' : 'imagem';
    return `${fmt} · ${cr.origin === 'reuse' ? 'reusado de um anúncio da conta' : 'da sua biblioteca'}`;
  });
  /** nome legível do vencedor (pro preview do sufixo na escala). */
  protected readonly sourceLabel = computed(() => this.draft().sourceName ?? 'vencedor');
  /** placeholder do nome derivado (o que o agente usa se você deixar em branco). */
  protected readonly derivedNamePlaceholder = computed(() => {
    const o = this.draft().objective;
    return o ? `CaquiAI — ${conversionLabel(o)}` : 'CaquiAI';
  });

  ngOnInit(): void {
    const d = this.draft();
    this.campaignName.set(d.campaignName ?? '');
    this.adsetName.set(d.adsetName ?? '');
    this.objective.set(d.objective ?? '');
    this.suffixLabel.set(d.suffixLabel ?? '');
    this.budget.set(d.dailyBudgetMajor);
    this.activation.set(d.activation);
    if (d.audience === 'reuse' || d.audience === 'broad') this.audience.set(d.audience);
    this.copies.set(
      (d.copyVariants ?? []).map((c) => ({
        adName: c.adName ?? '',
        headline: c.headline,
        primaryText: c.primaryText,
        description: c.description ?? '',
      })),
    );
  }

  /** Toggle "Ao aprovar" (o grupo emite string[] no modo single) → normaliza pro signal. */
  protected setActivation(value: string | string[]): void {
    const v = Array.isArray(value) ? value[0] : value;
    if (v === 'active' || v === 'paused') this.activation.set(v);
  }

  /** Toggle "Público" (reuse × amplo) — vai no diff do Salvar (campo `audience` do PATCH). */
  protected setAudience(value: string | string[]): void {
    const v = Array.isArray(value) ? value[0] : value;
    if (v === 'reuse' || v === 'broad') this.audience.set(v);
  }

  /** Troca o criativo (ação imediata — endpoint próprio resolve o reuse ao vivo). Mantém o painel
   *  aberto e pede ao pai pra recarregar (a miniatura do card e o rótulo aqui refletem o novo). */
  protected onPick(choice: SetDraftCreativeInput): void {
    this.picking.set(true);
    this.api.setDraftCreative(this.draft().accountId, this.draft().draftId, choice).subscribe({
      next: () => {
        this.picking.set(false);
        this.showPicker.set(false);
        toast.success('Criativo trocado neste rascunho.');
        this.creativeChanged.emit();
      },
      error: (err: unknown) => {
        this.picking.set(false);
        toast.error(this.errorMessage(err));
      },
    });
  }

  /** Remove um anúncio (mín 1) — ação imediata (o backend re-indexa). */
  protected removeAd(index: number): void {
    if (this.copies().length <= 1) return;
    this.persist({ removeAdIndex: index }, 'Anúncio removido.');
  }

  /** Salva os campos alterados (diff contra o rascunho original) num único PATCH. */
  protected save(): void {
    const patch = this.buildPatch();
    if (Object.keys(patch).length === 0) {
      this.close.emit();
      return;
    }
    this.persist(patch, 'Rascunho atualizado.');
  }

  private persist(patch: UpdateDraftInput, successMsg: string): void {
    this.saving.set(true);
    this.api.updateDraft(this.draft().accountId, this.draft().draftId, patch).subscribe({
      next: () => {
        this.saving.set(false);
        toast.success(successMsg);
        this.saved.emit();
      },
      error: (err: unknown) => {
        this.saving.set(false);
        toast.error(this.errorMessage(err));
      },
    });
  }

  /** Extrai a mensagem amigável do 422 do backend (§13) — nunca o erro técnico cru. */
  private errorMessage(err: unknown): string {
    const message = (err as { error?: { message?: string } })?.error?.message;
    return message ?? 'Não consegui salvar essa edição. Tente de novo.';
  }

  /** Monta o patch só com o que MUDOU (reduz clobber chat↔site). */
  private buildPatch(): UpdateDraftInput {
    const d = this.draft();
    const patch: Record<string, unknown> = {};
    if (this.budget() > 0 && this.budget() !== d.dailyBudgetMajor) patch['budgetReais'] = this.budget();
    if (this.activation() !== d.activation) patch['activation'] = this.activation();

    if (this.isScale()) {
      if (this.trimmed(this.suffixLabel()) !== (d.suffixLabel ?? '')) {
        const v = this.trimmed(this.suffixLabel());
        if (v) patch['suffixLabel'] = v;
      }
      return patch as UpdateDraftInput;
    }

    if (this.trimmed(this.campaignName()) !== (d.campaignName ?? '')) {
      const v = this.trimmed(this.campaignName());
      if (v) patch['campaignName'] = v;
    }
    if (this.trimmed(this.adsetName()) !== (d.adsetName ?? '')) {
      const v = this.trimmed(this.adsetName());
      if (v) patch['adsetName'] = v;
    }
    if (this.objective() && this.objective() !== (d.objective ?? '')) patch['objective'] = this.objective();
    if (d.audience && this.audience() !== d.audience) patch['audience'] = this.audience();
    this.applyExplicitAudienceDiff(patch, d);

    const original = d.copyVariants ?? [];
    const edits = this.copies()
      .map((c, index) => this.copyEdit(c, original[index], index))
      .filter((e): e is NonNullable<typeof e> => e !== null);
    if (edits.length > 0) patch['copyEdits'] = edits;
    return patch as UpdateDraftInput;
  }

  /** Diff de UMA variação → copyEdit (ou null se nada mudou). Textos não-vazios (o backend exige). */
  private copyEdit(c: CopyForm, original: DraftCopy | undefined, index: number) {
    if (!original) return null;
    const edit: Record<string, unknown> = { index };
    let changed = false;
    // Compara SEMPRE pelo valor trimado (o que de fato será enviado) → edição só de espaço = no-op.
    const adName = this.trimmed(c.adName);
    if (adName && adName !== (original.adName ?? '')) { edit['adName'] = adName; changed = true; }
    const headline = this.trimmed(c.headline);
    if (headline && headline !== original.headline) { edit['headline'] = headline; changed = true; }
    const primaryText = this.trimmed(c.primaryText);
    if (primaryText && primaryText !== original.primaryText) { edit['primaryText'] = primaryText; changed = true; }
    const description = this.trimmed(c.description);
    if (description !== (original.description ?? '')) { edit['description'] = description; changed = true; }
    return changed ? edit : null;
  }

  private trimmed(v: string): string {
    return v.trim();
  }

  /** Diff do público EXPLÍCITO (Fase 1, subfatia 3b) contra o que veio do backend — só manda o que
   *  MUDOU (removeGeo/addGeo por diferença de key; idade só se editada). Sem edição → patch vazio. */
  private applyExplicitAudienceDiff(patch: Record<string, unknown>, d: DraftApprovalOutput): void {
    const original = d.explicitAudience;
    const current = this.explicitAudienceState();
    if (!original || !current) return;
    const originalKeys = new Set(original.geo.map((g) => g.key));
    const currentKeys = new Set(current.geo.map((g) => g.key));
    const removeGeo = original.geo.filter((g) => !currentKeys.has(g.key)).map((g) => g.name);
    const addGeo = current.geo.filter((g) => !originalKeys.has(g.key));
    if (removeGeo.length > 0) patch['removeGeo'] = removeGeo;
    if (addGeo.length > 0) patch['addGeo'] = addGeo;
    if (current.ageMin != null && current.ageMin !== original.ageMin) patch['ageMin'] = current.ageMin;
    if (current.ageMax != null && current.ageMax !== original.ageMax) patch['ageMax'] = current.ageMax;

    const originalInterestIds = new Set(original.interests.map((i) => i.id));
    const currentInterestIds = new Set(current.interests.map((i) => i.id));
    const removeInterests = original.interests.filter((i) => !currentInterestIds.has(i.id)).map((i) => i.name);
    const addInterests = current.interests.filter((i) => !originalInterestIds.has(i.id));
    if (removeInterests.length > 0) patch['removeInterests'] = removeInterests;
    if (addInterests.length > 0) patch['addInterests'] = addInterests;
  }
}
