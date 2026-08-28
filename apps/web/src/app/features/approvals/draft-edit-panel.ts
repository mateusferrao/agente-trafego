import { ChangeDetectionStrategy, Component, computed, inject, input, type OnInit, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { toast } from 'ngx-sonner';
import { UiButton, UiInput } from '@ui';
import { DraftsApiService } from '@core/api/drafts-api.service';
import { CONVERSION_LABEL } from '@app/shared/conversion-label';
import type { DraftApprovalOutput, UpdateDraftInput } from '@core/api/generated';

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
  imports: [FormsModule, UiButton, UiInput],
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
          <select appInput class="w-full" [(ngModel)]="objective">
            @for (o of objectiveOptions; track o[0]) {
              <option [value]="o[0]">{{ o[1] }}</option>
            }
          </select>
          <span class="text-[11px] text-muted">Objetivos de venda/lead precisam do pixel configurado na conta.</span>
        </label>
      }

      <!-- Gasto + ativação (comuns) -->
      <div class="flex flex-wrap gap-4">
        <label class="flex flex-1 flex-col gap-1">
          <span class="text-xs font-medium text-ink">Gasto por dia ({{ draft().currency }})</span>
          <input appInput class="w-full" type="number" min="1" step="1" [(ngModel)]="budget" />
        </label>
        <div class="flex flex-col gap-1">
          <span class="text-xs font-medium text-ink">Ao aprovar</span>
          <span class="flex gap-2">
            <button appButton [variant]="activation() === 'paused' ? 'secondary' : 'ghost'" size="sm" (click)="activation.set('paused')">
              Deixar pausada
            </button>
            <button appButton [variant]="activation() === 'active' ? 'secondary' : 'ghost'" size="sm" (click)="activation.set('active')">
              Ativar em seguida
            </button>
          </span>
        </div>
      </div>

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
              <textarea appInput class="w-full" rows="2" [(ngModel)]="c.primaryText" placeholder="Texto principal"></textarea>
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
  /** salvou (o pai recarrega os rascunhos). */
  readonly saved = output<void>();
  readonly close = output<void>();

  protected readonly saving = signal(false);
  protected readonly campaignName = signal('');
  protected readonly adsetName = signal('');
  protected readonly objective = signal('');
  protected readonly suffixLabel = signal('');
  /** opções de objetivo (valor neutro + rótulo PT) — fonte única do frontend. */
  protected readonly objectiveOptions = Object.entries(CONVERSION_LABEL);
  protected readonly budget = signal(0);
  protected readonly activation = signal<'active' | 'paused'>('paused');
  protected readonly copies = signal<CopyForm[]>([]);

  protected readonly isScale = computed(() => this.draft().kind === 'duplicate');
  /** nome legível do vencedor (pro preview do sufixo na escala). */
  protected readonly sourceLabel = computed(() => this.draft().sourceName ?? 'vencedor');
  /** placeholder do nome derivado (o que o agente usa se você deixar em branco). */
  protected readonly derivedNamePlaceholder = computed(() => {
    const o = this.draft().objective;
    return o ? `CaquiAI — ${o}` : 'CaquiAI';
  });

  ngOnInit(): void {
    const d = this.draft();
    this.campaignName.set(d.campaignName ?? '');
    this.adsetName.set(d.adsetName ?? '');
    this.objective.set(d.objective ?? '');
    this.suffixLabel.set(d.suffixLabel ?? '');
    this.budget.set(d.dailyBudgetMajor);
    this.activation.set(d.activation);
    this.copies.set(
      (d.copyVariants ?? []).map((c) => ({
        adName: c.adName ?? '',
        headline: c.headline,
        primaryText: c.primaryText,
        description: c.description ?? '',
      })),
    );
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
    if (this.trimmed(c.adName) && c.adName !== (original.adName ?? '')) { edit['adName'] = this.trimmed(c.adName); changed = true; }
    if (this.trimmed(c.headline) && c.headline !== original.headline) { edit['headline'] = this.trimmed(c.headline); changed = true; }
    if (this.trimmed(c.primaryText) && c.primaryText !== original.primaryText) { edit['primaryText'] = this.trimmed(c.primaryText); changed = true; }
    if (c.description !== (original.description ?? '')) { edit['description'] = this.trimmed(c.description); changed = true; }
    return changed ? edit : null;
  }

  private trimmed(v: string): string {
    return v.trim();
  }
}
