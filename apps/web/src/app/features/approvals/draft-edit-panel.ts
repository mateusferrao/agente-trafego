import { ChangeDetectionStrategy, Component, computed, effect, inject, input, type OnInit, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { toast } from 'ngx-sonner';
import { UiButton, UiInput, UiSelectBox, UiToggleGroup, UiToggleGroupItem, type UiSelectOptionItem } from '@ui';
import { CreativePicker } from './creative-picker';
import { GeoAudienceEditor, toExplicitAudienceWire, type ExplicitAudienceState } from './geo-audience-editor';
import { DraftsApiService } from '@core/api/drafts-api.service';
import { CONVERSION_LABEL, conversionLabel } from '@app/shared/conversion-label';
import type { DraftApprovalOutput, SetDraftCreativeInput, UpdateDraftInput } from '@core/api/generated';

/** Uma variação de copy no formulário (espelho editável do `DraftApprovalOutput.copyVariants`). */
interface CopyForm {
  adName: string;
  headline: string;
  primaryText: string;
  description: string;
  /** troca de criativo PRÓPRIO deste anúncio, pendente até Salvar (Fatia 7). `undefined` = mantém. */
  creativeChoice?: SetDraftCreativeInput;
}

/** Um item de copy do rascunho (elemento do array de saída). */
type DraftCopy = NonNullable<DraftApprovalOutput['copyVariants']>[number];

/** Um conjunto do teste de público (C2/U1) no formulário — público + orçamento (ABO) + criativo
 *  PRÓPRIO (mesma copy compartilhada, criativo diferente). Espelha o padrão de `CopyForm`. */
interface ConjuntoForm {
  name: string;
  /** orçamento diário (ABO). `null` = CBO (verba na campanha, editada no "Gasto por dia" geral). */
  budget: number | null;
  /** `broad` = a Meta escolhe; `custom` = revela o `GeoAudienceEditor`. */
  audienceMode: 'broad' | 'custom';
  audienceState: ExplicitAudienceState | null;
  /** troca de criativo deste conjunto, pendente até Salvar. `undefined` = usa o compartilhado. */
  creativeChoice?: SetDraftCreativeInput;
  /** criativo próprio já salvo (só p/ o rótulo). */
  existingCreative?: { format: 'image' | 'video'; origin: 'reuse' | 'upload' } | null;
  /** índice deste conjunto na lista ORIGINAL do rascunho (`spec.adsets`) no momento do load; usado p/
   *  preservar o criativo próprio já salvo no round-trip (`keepCreativeIndex`). `undefined` = conjunto
   *  novo (adicionado nesta edição, sem criativo próprio a preservar). */
  originalIndex?: number;
}

/** Teto de anúncios por rascunho — espelha MAX_ADS_PER_DRAFT de @trafego/shared (backend é a
 *  fonte da verdade; aqui só desabilita o "adicionar" na UI). */
const MAX_ADS = 10;

/** Teto de conjuntos num teste de público — guarda de UI contra listas ilimitadas (um teste de
 *  público raramente passa de meia dúzia de segmentos). */
const MAX_CONJUNTOS = 8;

/** Público explícito VAZIO — semente do modo `custom` quando não há nada legível a herdar. */
const EMPTY_AUDIENCE_STATE: ExplicitAudienceState = {
  geo: [],
  radiusAreas: [],
  ageMin: null,
  ageMax: null,
  genders: null,
  interestGroups: [],
  behaviorGroups: [],
  customAudienceIncludeIds: [],
  customAudienceExcludeIds: [],
};

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
        @if (objective() !== 'messaging_started') {
          <label class="flex flex-col gap-1">
            <span class="text-xs font-medium text-ink">Link de destino</span>
            <input appInput class="w-full" type="url" inputmode="url" [(ngModel)]="linkUrl" placeholder="https://sualoja.com/promo" />
            <span class="text-[11px] text-muted">Pra onde o clique no anúncio leva. Em branco = herda o link do seu anúncio-base.</span>
          </label>
        }
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

      <!-- Público — 3 modos num único controle (Slice 8 unificado): herda o vencedor / a Meta
           escolhe / personalizado. "Personalizado" revela o editor completo (geo/raio/idade/gênero/
           interesses/comportamentos/públicos salvos) abaixo. Some na escala (mantém o vencedor). -->
      @if (!isScale() && !hasAdsets()) {
        <div class="flex flex-col gap-2">
          <span class="text-xs font-medium text-ink">Público</span>
          <div
            appToggleGroup
            ngpToggleGroupType="single"
            layout="segmented"
            [columns]="3"
            aria-label="Público"
            [ngpToggleGroupValue]="[audienceMode()]"
            (ngpToggleGroupValueChange)="setAudienceMode($event)"
          >
            <button appToggleGroupItem tone="accent" ngpToggleGroupItemValue="reuse">Herda o que já converte</button>
            <button appToggleGroupItem tone="accent" ngpToggleGroupItemValue="broad">Deixa a Meta escolher</button>
            <button appToggleGroupItem tone="accent" ngpToggleGroupItemValue="custom">Personalizado</button>
          </div>
          @if (audienceMode() === 'custom') {
            <p class="rounded-md border border-line bg-panel px-3 py-2 text-xs text-muted">
              Você monta o público à mão — o rascunho para de seguir o vencedor automaticamente.
            </p>
            <app-geo-audience-editor
              [accountId]="draft().accountId"
              [draftId]="draft().draftId"
              [initial]="editorSeed()"
              (stateChange)="explicitAudienceState.set($event)"
            />
          }
        </div>
      }

      <!-- CONJUNTOS (teste de público multi-conjunto, C2/U1): cada conjunto com seu público +
           orçamento (ABO) + criativo próprio. Mesmo criativo compartilhado por padrão (isola o
           público); trocar por conjunto é aqui. Add/remover espelha o padrão de anúncios. -->
      @if (!isScale() && hasAdsets()) {
        <div class="flex flex-col gap-3">
          <span class="text-xs font-medium text-ink">Conjuntos (teste de público — mesmo criativo, públicos diferentes)</span>
          @for (cj of conjuntos(); track $index) {
            <div class="flex flex-col gap-2 rounded-md border border-line bg-panel p-3">
              <div class="flex items-center justify-between">
                <span class="text-[11px] font-medium uppercase tracking-wide text-muted">Conjunto {{ $index + 1 }}</span>
                <button
                  type="button"
                  class="text-[11px] text-muted hover:text-ink disabled:opacity-40"
                  [disabled]="conjuntos().length <= 2 || saving()"
                  (click)="removeConjunto($index)"
                >
                  Remover
                </button>
              </div>
              <input appInput class="w-full" [(ngModel)]="cj.name" placeholder="Nome do conjunto (ex: Interesse em estética)" />
              @if (isAbo()) {
                <label class="flex flex-col gap-1">
                  <span class="text-xs font-medium text-ink">Gasto por dia deste conjunto ({{ draft().currency }})</span>
                  <input appInput class="w-full" type="number" min="1" step="1" [ngModel]="cj.budget" (ngModelChange)="setConjuntoBudget($index, $event)" />
                </label>
              }
              <!-- público do conjunto: a Meta escolhe × personalizado (revela o editor) -->
              <div
                appToggleGroup
                ngpToggleGroupType="single"
                layout="segmented"
                [columns]="2"
                aria-label="Público do conjunto"
                [ngpToggleGroupValue]="[cj.audienceMode]"
                (ngpToggleGroupValueChange)="setConjuntoAudienceMode($index, $event)"
              >
                <button appToggleGroupItem tone="accent" ngpToggleGroupItemValue="broad">A Meta escolhe</button>
                <button appToggleGroupItem tone="accent" ngpToggleGroupItemValue="custom">Personalizado</button>
              </div>
              @if (cj.audienceMode === 'custom') {
                <app-geo-audience-editor
                  [accountId]="draft().accountId"
                  [draftId]="draft().draftId"
                  [initial]="conjuntoSeed($index)"
                  (stateChange)="onConjuntoAudience($index, $event)"
                />
              }
              <!-- criativo próprio do conjunto (mesma copy, criativo diferente) -->
              <div class="flex flex-col gap-2 border-t border-line pt-2 sm:flex-row sm:items-center sm:justify-between">
                <span class="text-xs text-ink"><span class="text-muted">Criativo: </span>{{ conjuntoCreativeLabel($index) }}</span>
                <button appButton variant="ghost" size="sm" type="button" class="shrink-0 self-start sm:self-auto" [disabled]="saving()" (click)="toggleConjuntoPicker($index)">
                  {{ pickingConjuntoIndex() === $index ? 'Cancelar troca' : 'Trocar criativo deste conjunto' }}
                </button>
              </div>
              @if (pickingConjuntoIndex() === $index) {
                <app-creative-picker
                  [accountId]="draft().accountId"
                  [picking]="false"
                  (pick)="onConjuntoCreative($index, $event)"
                  (cancel)="pickingConjuntoIndex.set(null)"
                />
              }
            </div>
          }
          <button appButton variant="secondary" size="sm" type="button" class="self-start" [disabled]="saving() || conjuntos().length >= MAX_CONJUNTOS" (click)="addConjunto()">
            + Adicionar conjunto
          </button>
        </div>
      }

      <!-- Criativo PADRÃO do rascunho (troca imediata — biblioteca × anúncio ao vivo; só criação).
           Usado pelos anúncios sem criativo próprio. -->
      @if (!isScale()) {
        <div class="flex flex-col gap-2">
          <span class="text-xs font-medium text-ink">Criativo padrão</span>
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

      <!-- Anúncios (só criação): copy + criativo POR ANÚNCIO + adicionar/remover. -->
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
              <!-- criativo POR ANÚNCIO: próprio × padrão do rascunho; troca pendente até Salvar. -->
              <div class="flex flex-col gap-2 border-t border-line pt-2 sm:flex-row sm:items-center sm:justify-between">
                <span class="text-xs text-ink"><span class="text-muted">Criativo: </span>{{ adCreativeLabel($index) }}</span>
                <button appButton variant="ghost" size="sm" type="button" class="shrink-0 self-start sm:self-auto" [disabled]="saving()" (click)="toggleAdPicker($index)">
                  {{ pickingAdIndex() === $index ? 'Cancelar troca' : 'Trocar criativo deste anúncio' }}
                </button>
              </div>
              @if (pickingAdIndex() === $index) {
                <app-creative-picker
                  [accountId]="draft().accountId"
                  [picking]="false"
                  (pick)="onPickAd($index, $event)"
                  (cancel)="pickingAdIndex.set(null)"
                />
              }
            </div>
          }
          <button appButton variant="secondary" size="sm" type="button" class="self-start" [disabled]="saving() || copies().length >= MAX_ADS" (click)="addAd()">
            + Adicionar anúncio
          </button>
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
  /** URL de destino do anúncio (só from_scratch com objetivo de site/tráfego/conversão) — o clique
   *  leva pra cá. Escondido em conversas no WhatsApp (leva pro WhatsApp, não pra um site). */
  protected readonly linkUrl = signal('');
  /** modo do público (controle único de 3 opções): `reuse`/`broad` = herdado; `custom` = revela o
   *  editor completo abaixo (converte reuse/broad → explicit no Salvar). */
  protected readonly audienceMode = signal<'reuse' | 'broad' | 'custom'>('reuse');
  /** estado COMPLETO do editor de público explícito (Slice 8) — atualizado a cada mudança no filho;
   *  vai no PATCH como substituição total quando o modo é `custom`. `null` = ainda não personalizado. */
  protected readonly explicitAudienceState = signal<ExplicitAudienceState | null>(null);
  protected readonly copies = signal<CopyForm[]>([]);
  /** picker de criativo aberto dentro do painel + troca em voo. */
  protected readonly showPicker = signal(false);
  protected readonly picking = signal(false);
  /** índice do anúncio cujo picker de criativo está aberto (null = nenhum). */
  protected readonly pickingAdIndex = signal<number | null>(null);
  /** teto de anúncios (exposto ao template). */
  protected readonly MAX_ADS = MAX_ADS;
  /** teto de conjuntos (exposto ao template). */
  protected readonly MAX_CONJUNTOS = MAX_CONJUNTOS;
  /** Conjuntos do teste de público (C2/U1) — vazio = rascunho single-conjunto (usa os campos acima). */
  protected readonly conjuntos = signal<ConjuntoForm[]>([]);
  /** índice do conjunto cujo picker de criativo está aberto (null = nenhum). */
  protected readonly pickingConjuntoIndex = signal<number | null>(null);
  /** algum conjunto foi MEXIDO nesta edição? Sem isso, `buildPatch` NÃO manda `adsets` (a substituição
   *  é total — reenviar sem mudança no-opa E clobbaria uma edição concorrente do chat aos conjuntos). */
  protected readonly conjuntosDirty = signal(false);

  protected readonly isScale = computed(() => this.draft().kind === 'duplicate');
  /** rascunho multi-conjunto (teste de público) → mostra a seção de conjuntos, esconde o público único. */
  protected readonly hasAdsets = computed(() => (this.draft().adsets?.length ?? 0) > 0);
  /** ABO = orçamento por conjunto (mostra o campo de gasto em cada conjunto); CBO = verba na campanha. */
  protected readonly isAbo = computed(() => this.draft().budgetMode === 'abo');
  /** rótulo do criativo PADRÃO do rascunho (formato + origem) — sem jargão, sem id técnico. */
  protected readonly creativeLabel = computed(() => this.formatCreative(this.draft().creative));
  /** formata um criativo (formato + origem) em linguagem de gente; `null` → sem criativo. */
  private formatCreative(cr: { format: 'image' | 'video'; origin: 'reuse' | 'upload' } | null | undefined): string {
    if (!cr) return 'nenhum criativo escolhido';
    const fmt = cr.format === 'video' ? 'vídeo' : 'imagem';
    return `${fmt} · ${cr.origin === 'reuse' ? 'reusado de um anúncio da conta' : 'da sua biblioteca'}`;
  }
  /** rótulo do criativo de UM anúncio: troca pendente > próprio salvo > "usa o criativo padrão". */
  protected adCreativeLabel(index: number): string {
    if (this.copies()[index]?.creativeChoice) return 'novo criativo escolhido (salve pra aplicar)';
    const own = this.draft().copyVariants?.[index]?.creative;
    return own ? `próprio — ${this.formatCreative(own)}` : 'usa o criativo padrão';
  }
  /** nome legível do vencedor (pro preview do sufixo na escala). */
  protected readonly sourceLabel = computed(() => this.draft().sourceName ?? 'vencedor');
  /** placeholder do nome derivado (o que o agente usa se você deixar em branco). */
  protected readonly derivedNamePlaceholder = computed(() => {
    const o = this.draft().objective;
    return o ? `CaquiAI — ${conversionLabel(o)}` : 'CaquiAI';
  });
  /** semente do editor pro rascunho já explícito — estado COMPLETO a partir do backend. */
  protected readonly explicitInitial = computed<ExplicitAudienceState | null>(() => {
    const ea = this.draft().explicitAudience;
    if (!ea) return null;
    return {
      geo: ea.geo,
      radiusAreas: ea.radiusAreas,
      ageMin: ea.ageMin,
      ageMax: ea.ageMax,
      genders: ea.genders,
      interestGroups: ea.interestGroups,
      behaviorGroups: ea.behaviorGroups,
      customAudienceIncludeIds: ea.customAudienceIncludeIds,
      customAudienceExcludeIds: ea.customAudienceExcludeIds,
    };
  });
  /** semente do editor no converter modo — só o geo/idade do `convertibleAudience`, resto vazio. */
  protected readonly convertibleInitial = computed<ExplicitAudienceState | null>(() => {
    const ca = this.draft().convertibleAudience;
    if (!ca) return null;
    return {
      geo: ca.geo.map((g) => ({ key: g.key, name: g.name, kind: g.kind, radius: null, distanceUnit: null })),
      radiusAreas: [],
      ageMin: ca.ageMin,
      ageMax: ca.ageMax,
      genders: null,
      interestGroups: [],
      behaviorGroups: [],
      customAudienceIncludeIds: [],
      customAudienceExcludeIds: [],
    };
  });
  /** semente do modo `custom`: já explícito → o estado atual; reuse/broad → geo/idade herdados;
   *  nada legível → público vazio (o dono monta do zero). */
  protected readonly customSeed = computed<ExplicitAudienceState>(
    () => this.explicitInitial() ?? this.convertibleInitial() ?? EMPTY_AUDIENCE_STATE,
  );
  /** `[initial]` do editor: preserva edições ao alternar de modo e voltar (o filho semeia 1x por
   *  instância — o estado já editado ganha da semente herdada). */
  protected readonly editorSeed = computed<ExplicitAudienceState>(() => this.explicitAudienceState() ?? this.customSeed());

  /** nº de anúncios já semeado em copies() — detecta add/remove estrutural vindo do reload. */
  private seededVariantCount = 0;
  private initialized = false;

  constructor() {
    // Re-semeia copies() quando o Nº DE ANÚNCIOS muda no reload (add/remover via persist estrutural) —
    // mantém o painel aberto e sincronizado sem clobbar edições em andamento nos outros casos (o
    // reload de troca-de-criativo não muda o comprimento → não re-semeia). Edições pendentes já foram
    // enviadas no mesmo PATCH do add/remove, então o draft() recarregado já as reflete.
    effect(
      () => {
        const n = this.draft().copyVariants?.length ?? 0;
        if (this.initialized && n !== this.seededVariantCount) {
          this.seedCopies(this.draft());
          this.seededVariantCount = n;
        }
      },
      { allowSignalWrites: true },
    );
  }

  /** Semeia copies() a partir do rascunho (usado no init e no re-seed pós add/remove). */
  private seedCopies(d: DraftApprovalOutput): void {
    this.copies.set(
      (d.copyVariants ?? []).map((c) => ({
        adName: c.adName ?? '',
        headline: c.headline,
        primaryText: c.primaryText,
        description: c.description ?? '',
      })),
    );
  }

  /** Mapeia o público explícito do output (conjunto ou rascunho) → estado do editor. */
  private toAudienceState(ea: NonNullable<DraftApprovalOutput['explicitAudience']>): ExplicitAudienceState {
    return {
      geo: ea.geo,
      radiusAreas: ea.radiusAreas,
      ageMin: ea.ageMin,
      ageMax: ea.ageMax,
      genders: ea.genders,
      interestGroups: ea.interestGroups,
      behaviorGroups: ea.behaviorGroups,
      customAudienceIncludeIds: ea.customAudienceIncludeIds,
      customAudienceExcludeIds: ea.customAudienceExcludeIds,
    };
  }

  /** Semeia conjuntos() a partir do rascunho multi-conjunto (C2/U1). */
  private seedConjuntos(d: DraftApprovalOutput): void {
    this.conjuntos.set(
      (d.adsets ?? []).map((as, i) => ({
        name: as.name ?? '',
        budget: as.dailyBudgetMajor,
        audienceMode: as.explicitAudience ? 'custom' : 'broad',
        audienceState: as.explicitAudience ? this.toAudienceState(as.explicitAudience) : null,
        existingCreative: as.creative,
        originalIndex: i,
      })),
    );
    this.conjuntosDirty.set(false);
  }

  /** semente do editor de público de UM conjunto (preserva a edição em voo). */
  protected conjuntoSeed(index: number): ExplicitAudienceState {
    return this.conjuntos()[index]?.audienceState ?? EMPTY_AUDIENCE_STATE;
  }

  /** rótulo do criativo de UM conjunto: troca pendente > próprio salvo > compartilhado. */
  protected conjuntoCreativeLabel(index: number): string {
    const cj = this.conjuntos()[index];
    if (cj?.creativeChoice) return 'novo criativo escolhido (salve pra aplicar)';
    return cj?.existingCreative ? `próprio — ${this.formatCreative(cj.existingCreative)}` : 'usa o criativo compartilhado';
  }

  protected setConjuntoBudget(index: number, value: number): void {
    this.conjuntos.update((list) => list.map((c, i) => (i === index ? { ...c, budget: value } : c)));
    this.conjuntosDirty.set(true);
  }

  protected setConjuntoAudienceMode(index: number, value: string | string[]): void {
    const v = Array.isArray(value) ? value[0] : value;
    if (v !== 'broad' && v !== 'custom') return;
    this.conjuntos.update((list) =>
      list.map((c, i) =>
        i === index ? { ...c, audienceMode: v, audienceState: v === 'custom' ? (c.audienceState ?? EMPTY_AUDIENCE_STATE) : c.audienceState } : c,
      ),
    );
    this.conjuntosDirty.set(true);
  }

  protected onConjuntoAudience(index: number, state: ExplicitAudienceState): void {
    this.conjuntos.update((list) => list.map((c, i) => (i === index ? { ...c, audienceState: state } : c)));
    this.conjuntosDirty.set(true);
  }

  protected toggleConjuntoPicker(index: number): void {
    this.pickingConjuntoIndex.update((cur) => (cur === index ? null : index));
  }

  protected onConjuntoCreative(index: number, choice: SetDraftCreativeInput): void {
    this.conjuntos.update((list) => list.map((c, i) => (i === index ? { ...c, creativeChoice: choice } : c)));
    this.pickingConjuntoIndex.set(null);
    this.conjuntosDirty.set(true);
  }

  /** Adiciona um conjunto vazio (público amplo por padrão) — o dono personaliza. Teto = MAX_CONJUNTOS. */
  protected addConjunto(): void {
    if (this.conjuntos().length >= MAX_CONJUNTOS) return;
    this.conjuntos.update((list) => [...list, { name: '', budget: null, audienceMode: 'broad', audienceState: null }]);
    this.conjuntosDirty.set(true);
  }

  /** Remove um conjunto (mín 2 — abaixo disso não é mais teste de público). */
  protected removeConjunto(index: number): void {
    if (this.conjuntos().length <= 2) return;
    this.conjuntos.update((list) => list.filter((_, i) => i !== index));
    // o picker aberto vira posicional inválido após a remoção → fecha (senão anexaria no conjunto errado).
    this.pickingConjuntoIndex.set(null);
    this.conjuntosDirty.set(true);
  }

  ngOnInit(): void {
    const d = this.draft();
    this.campaignName.set(d.campaignName ?? '');
    this.adsetName.set(d.adsetName ?? '');
    this.objective.set(d.objective ?? '');
    this.suffixLabel.set(d.suffixLabel ?? '');
    this.budget.set(d.dailyBudgetMajor);
    this.activation.set(d.activation);
    this.linkUrl.set(d.linkUrl ?? '');
    // modo do público: já explícito → custom; senão o herdado (reuse/broad).
    this.audienceMode.set(d.explicitAudience ? 'custom' : d.audience === 'broad' ? 'broad' : 'reuse');
    this.seedCopies(d);
    this.seedConjuntos(d);
    this.seededVariantCount = d.copyVariants?.length ?? 0;
    // rascunho já explícito → o estado nasce completo (Salvar re-envia como substituição total).
    this.explicitAudienceState.set(this.explicitInitial());
    this.initialized = true;
  }

  /** Toggle "Ao aprovar" (o grupo emite string[] no modo single) → normaliza pro signal. */
  protected setActivation(value: string | string[]): void {
    const v = Array.isArray(value) ? value[0] : value;
    if (v === 'active' || v === 'paused') this.activation.set(v);
  }

  /** Toggle "Público" (herda / a Meta escolhe / personalizado). `custom` semeia o editor na hora
   *  (salvável mesmo sem edição extra — converte o herdado em explícito). */
  protected setAudienceMode(value: string | string[]): void {
    const v = Array.isArray(value) ? value[0] : value;
    if (v !== 'reuse' && v !== 'broad' && v !== 'custom') return;
    this.audienceMode.set(v);
    if (v === 'custom' && !this.explicitAudienceState()) this.explicitAudienceState.set(this.customSeed());
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

  /** Remove um anúncio (mín 1). Inclui as edições PENDENTES no mesmo PATCH (não perde nada) e mantém
   *  o painel aberto (re-semeia via effect ao recarregar). */
  protected removeAd(index: number): void {
    if (this.copies().length <= 1) return;
    this.persistStructural({ ...this.buildPatch(), removeAdIndex: index }, 'Anúncio removido.');
  }

  /** Adiciona um anúncio DUPLICANDO o último. Inclui as edições PENDENTES no mesmo PATCH e mantém o
   *  painel aberto — o novo anúncio aparece pronto pra editar (fluxo "adiciona e continua"). */
  protected addAd(): void {
    if (this.copies().length >= MAX_ADS) return;
    this.persistStructural({ ...this.buildPatch(), addAd: true }, 'Anúncio adicionado.');
  }

  /** Persiste uma mudança ESTRUTURAL (add/remove anúncio) + edições pendentes, MANTENDO o painel
   *  aberto (emite creativeChanged → o pai recarrega sem fechar; o effect re-semeia copies()). */
  private persistStructural(patch: UpdateDraftInput, successMsg: string): void {
    this.saving.set(true);
    this.api.updateDraft(this.draft().accountId, this.draft().draftId, patch).subscribe({
      next: () => {
        this.saving.set(false);
        toast.success(successMsg);
        this.creativeChanged.emit();
      },
      error: (err: unknown) => {
        this.saving.set(false);
        toast.error(this.errorMessage(err));
      },
    });
  }

  /** Abre/fecha o picker de criativo de UM anúncio. */
  protected toggleAdPicker(index: number): void {
    this.pickingAdIndex.update((cur) => (cur === index ? null : index));
  }

  /** Escolhe o criativo de UM anúncio (pendente até Salvar — vai no `copyEdits[index].creative`). */
  protected onPickAd(index: number, choice: SetDraftCreativeInput): void {
    this.copies.update((list) => list.map((c, i) => (i === index ? { ...c, creativeChoice: choice } : c)));
    this.pickingAdIndex.set(null);
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
    // link de destino: só quando não é conversa no WhatsApp e o dono digitou algo NOVO (URL válida).
    // Em branco = mantém o herdado (a API exige URL válida, então "" não reseta — não regride).
    if (this.objective() !== 'messaging_started') {
      const link = this.trimmed(this.linkUrl());
      if (link && link !== (d.linkUrl ?? '')) patch['linkUrl'] = link;
    }

    // público: `custom` manda o estado COMPLETO como SUBSTITUIÇÃO total (converte reuse/broad →
    // explicit no backend). reuse/broad só entram no patch quando MUDAM do modo original (evita
    // clobber). Modo original: rascunho já explícito = `custom`; senão o `audience` herdado.
    const mode = this.audienceMode();
    const originalMode = d.explicitAudience ? 'custom' : d.audience; // 'custom' | 'reuse' | 'broad' | null
    if (mode === 'custom') {
      const explicit = this.explicitAudienceState();
      if (explicit) patch['explicitAudience'] = this.toExplicitInput(explicit);
      // só envia audience quando há um modo original CONHECIDO e o usuário mudou (evita `audience`
      // espúrio num rascunho sem targeting, onde originalMode é null e o signal cai no default).
    } else if (originalMode !== null && mode !== originalMode) {
      patch['audience'] = mode;
    }

    const original = d.copyVariants ?? [];
    const edits = this.copies()
      .map((c, index) => this.copyEdit(c, original[index], index))
      .filter((e): e is NonNullable<typeof e> => e !== null);
    if (edits.length > 0) patch['copyEdits'] = edits;

    // CONJUNTOS (C2/U1): substituição TOTAL da lista quando o rascunho é multi-conjunto. Cada
    // conjunto = público (explícito quando personalizado) + orçamento (ABO) + criativo próprio. Só
    // manda `adsets` quando ALGUM conjunto MUDOU (`conjuntosDirty`) — a substituição é total, então
    // reenviar sem mudança no-opa E clobbaria uma edição concorrente do chat aos conjuntos.
    // Criativo próprio: pick novo (`creativeChoice`) vence; senão `keepCreativeIndex` PRESERVA o que o
    // conjunto já tinha (o output não devolve id re-enviável do criativo) — índice de ORIGEM, robusto
    // a remover conjuntos; conjunto novo (sem origem/criativo próprio) → usa o compartilhado.
    if (this.hasAdsets() && this.conjuntosDirty()) {
      patch['adsets'] = this.conjuntos().map((cj) => ({
        ...(this.trimmed(cj.name) ? { name: this.trimmed(cj.name) } : {}),
        ...(cj.audienceMode === 'custom' && cj.audienceState ? { explicitAudience: this.toExplicitInput(cj.audienceState) } : {}),
        ...(this.isAbo() && cj.budget != null && cj.budget > 0 ? { budgetReais: cj.budget } : {}),
        ...(cj.creativeChoice
          ? { creative: cj.creativeChoice }
          : cj.existingCreative && cj.originalIndex != null
            ? { keepCreativeIndex: cj.originalIndex }
            : {}),
      }));
    }
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
    // troca de criativo próprio deste anúncio (pendente) → vai no PATCH; o backend resolve→CreativeAssetRef.
    if (c.creativeChoice) { edit['creative'] = c.creativeChoice; changed = true; }
    return changed ? edit : null;
  }

  private trimmed(v: string): string {
    return v.trim();
  }

  /** Mapeia o estado COMPLETO do editor pro input de substituição total do público (Slice 8) — fonte
   *  única compartilhada com o card de ação (`toExplicitAudienceWire`); o shape do wire é idêntico. */
  private toExplicitInput(s: ExplicitAudienceState): NonNullable<UpdateDraftInput['explicitAudience']> {
    return toExplicitAudienceWire(s);
  }
}
