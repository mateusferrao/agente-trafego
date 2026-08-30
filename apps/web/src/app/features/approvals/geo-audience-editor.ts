import { ChangeDetectionStrategy, Component, effect, inject, input, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Subject } from 'rxjs';
import { catchError, debounceTime, distinctUntilChanged, switchMap, of } from 'rxjs';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { UiBadge, UiInput, UiToggleGroup, UiToggleGroupItem } from '@ui';
import { DraftsApiService } from '@core/api/drafts-api.service';
import type { GeoSearchResultOutput, InterestSearchResultOutput } from '@core/api/generated';

/** Entrada neutra do público explícito (Fase 1 + Fase 2) — espelha `TargetingSpec.explicit`. */
export interface ExplicitAudienceState {
  geo: readonly { key: string; name: string; kind: 'country' | 'region' | 'city' }[];
  ageMin: number | null;
  ageMax: number | null;
  genders: readonly (1 | 2)[] | null;
  interests: readonly { id: string; name: string }[];
}

const SEARCH_DEBOUNCE_MS = 300;
/** Abaixo disso não busca (poupa chamada por cada tecla de 1-2 letras — sem resultado útil ainda). */
const MIN_QUERY_LEN = 2;

/**
 * Editor de público EXPLÍCITO por primitivos (Fase 1, subfatia 3b) — geo (autocomplete ao vivo
 * via `searchGeo`), idade e gênero. Presentacional: mantém o estado local e emite a cada mudança
 * (`stateChange`); o painel-pai (`draft-edit-panel`) inclui no diff do PATCH único ao Salvar — não
 * persiste sozinho (mesmo padrão dos outros campos do painel, diferente do `CreativePicker` que
 * troca na hora). Remover é local (sem chamada); adicionar busca ao vivo e some da lista ao clicar.
 */
@Component({
  selector: 'app-geo-audience-editor',
  standalone: true,
  imports: [FormsModule, UiInput, UiToggleGroup, UiToggleGroupItem, UiBadge],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="flex flex-col gap-3 rounded-md border border-line bg-panel p-3">
      <div class="flex flex-col gap-1.5">
        <span class="text-xs font-medium text-ink">Localização</span>
        @if (geo().length > 0) {
          <ul class="flex flex-wrap gap-1.5">
            @for (g of geo(); track g.key) {
              <li>
                <span appBadge tone="accent" class="pr-1">
                  {{ g.name }}
                  <button
                    type="button"
                    class="ml-0.5 rounded-full px-1 text-accent-strong/70 hover:text-accent-strong"
                    [attr.aria-label]="'Remover ' + g.name"
                    (click)="removeGeo(g.key)"
                  >
                    ×
                  </button>
                </span>
              </li>
            }
          </ul>
        } @else {
          <span class="text-[11px] text-muted">Nenhuma localização escolhida ainda.</span>
        }
        <div class="relative">
          <input
            appInput
            class="w-full"
            type="search"
            placeholder="Adicionar cidade, região ou país…"
            [(ngModel)]="query"
            (ngModelChange)="onQueryChange($event)"
          />
          @if (searching()) {
            <span class="absolute right-2 top-1/2 -translate-y-1/2 text-[11px] text-muted">buscando…</span>
          }
          @if (results().length > 0) {
            <ul class="absolute z-10 mt-1 w-full overflow-hidden rounded-md border border-line bg-app shadow-md">
              @for (r of results(); track r.key) {
                <li>
                  <button
                    type="button"
                    class="flex w-full items-center justify-between px-3 py-1.5 text-left text-sm text-ink hover:bg-soft"
                    (click)="addGeo(r)"
                  >
                    <span>{{ r.name }}</span>
                    <span class="text-[11px] text-muted">{{ kindLabel(r.kind) }}</span>
                  </button>
                </li>
              }
            </ul>
          } @else if (query().trim().length >= MIN_QUERY_LEN && searched() && !searching()) {
            <span class="mt-1 block text-[11px] text-muted">Nenhum lugar encontrado pra “{{ query() }}”.</span>
          }
        </div>
      </div>

      <div class="flex flex-col gap-4 sm:flex-row sm:items-start">
        <div class="flex flex-col gap-1 sm:flex-1">
          <span class="text-xs font-medium text-ink">Idade</span>
          <div class="flex items-center gap-2">
            <input appInput class="w-full" type="number" min="13" max="65" placeholder="mín." [(ngModel)]="ageMinInput" (ngModelChange)="emitState()" />
            <span class="text-xs text-muted">até</span>
            <input appInput class="w-full" type="number" min="13" max="65" placeholder="máx." [(ngModel)]="ageMaxInput" (ngModelChange)="emitState()" />
          </div>
        </div>
        <div class="flex flex-col gap-1 sm:flex-1">
          <span class="text-xs font-medium text-ink">Gênero</span>
          <div
            appToggleGroup
            ngpToggleGroupType="single"
            layout="segmented"
            [columns]="3"
            aria-label="Gênero"
            [ngpToggleGroupValue]="[gender()]"
            (ngpToggleGroupValueChange)="setGender($event)"
          >
            <button appToggleGroupItem tone="accent" ngpToggleGroupItemValue="all">Todos</button>
            <button appToggleGroupItem tone="accent" ngpToggleGroupItemValue="men">Homens</button>
            <button appToggleGroupItem tone="accent" ngpToggleGroupItemValue="women">Mulheres</button>
          </div>
        </div>
      </div>
      <div class="flex flex-col gap-1.5">
        <span class="text-xs font-medium text-ink">Interesses</span>
        @if (interests().length > 0) {
          <ul class="flex flex-wrap gap-1.5">
            @for (i of interests(); track i.id) {
              <li>
                <span appBadge tone="accent" class="pr-1">
                  {{ i.name }}
                  <button
                    type="button"
                    class="ml-0.5 rounded-full px-1 text-accent-strong/70 hover:text-accent-strong"
                    [attr.aria-label]="'Remover ' + i.name"
                    (click)="removeInterest(i.id)"
                  >
                    ×
                  </button>
                </span>
              </li>
            }
          </ul>
        } @else {
          <span class="text-[11px] text-muted">Nenhum interesse escolhido ainda.</span>
        }
        <div class="relative">
          <input
            appInput
            class="w-full"
            type="search"
            placeholder="Adicionar interesse (ex: estética, pets)…"
            [(ngModel)]="interestQuery"
            (ngModelChange)="onInterestQueryChange($event)"
          />
          @if (interestSearching()) {
            <span class="absolute right-2 top-1/2 -translate-y-1/2 text-[11px] text-muted">buscando…</span>
          }
          @if (interestResults().length > 0) {
            <ul class="absolute z-10 mt-1 w-full overflow-hidden rounded-md border border-line bg-app shadow-md">
              @for (r of interestResults(); track r.id) {
                <li>
                  <button
                    type="button"
                    class="flex w-full items-center justify-between px-3 py-1.5 text-left text-sm text-ink hover:bg-soft"
                    (click)="addInterest(r)"
                  >
                    <span>{{ r.name }}</span>
                    @if (r.path && r.path.length > 0) {
                      <span class="text-[11px] text-muted">{{ r.path.join(' > ') }}</span>
                    }
                  </button>
                </li>
              }
            </ul>
          } @else if (interestQuery().trim().length >= MIN_QUERY_LEN && interestSearched() && !interestSearching()) {
            <span class="mt-1 block text-[11px] text-muted">Nenhum interesse encontrado pra “{{ interestQuery() }}”.</span>
          }
        </div>
      </div>

      <span class="text-[11px] text-muted">Sem expansão de público — a campanha mira só o que você escolheu aqui.</span>

      @if (estimating()) {
        <span class="text-[11px] text-muted">Estimando alcance…</span>
      } @else if (reach()) {
        <span class="text-[11px] text-ink">{{ reach() }}</span>
      }
    </div>
  `,
})
export class GeoAudienceEditor {
  private readonly api = inject(DraftsApiService);
  private readonly querySubject = new Subject<string>();
  private readonly interestQuerySubject = new Subject<string>();
  private readonly reachSubject = new Subject<ExplicitAudienceState>();

  readonly accountId = input.required<string>();
  /** id do rascunho — usado só p/ estimar o alcance (Slice 7); o objetivo/pixel vêm dele no servidor. */
  readonly draftId = input.required<string>();
  readonly initial = input.required<ExplicitAudienceState>();
  /** emite o estado atual A CADA mudança — o pai lê no momento de montar o diff do Salvar. */
  readonly stateChange = output<ExplicitAudienceState>();
  /** nota de alcance estimado (Slice 7) — recalcula debounced ao editar; null = sem estimativa. */
  protected readonly reach = signal<string | null>(null);
  protected readonly estimating = signal(false);

  protected readonly MIN_QUERY_LEN = MIN_QUERY_LEN;
  protected readonly geo = signal<ExplicitAudienceState['geo']>([]);
  protected readonly ageMinInput = signal<number | null>(null);
  protected readonly ageMaxInput = signal<number | null>(null);
  protected readonly gender = signal<'all' | 'men' | 'women'>('all');
  protected readonly query = signal('');
  protected readonly results = signal<readonly GeoSearchResultOutput[]>([]);
  protected readonly searching = signal(false);
  protected readonly searched = signal(false);
  protected readonly interests = signal<ExplicitAudienceState['interests']>([]);
  protected readonly interestQuery = signal('');
  protected readonly interestResults = signal<readonly InterestSearchResultOutput[]>([]);
  protected readonly interestSearching = signal(false);
  protected readonly interestSearched = signal(false);

  constructor() {
    // inicializa do `initial()` UMA vez (o painel-pai não re-emite depois de montado).
    effect(
      () => {
        const init = this.initial();
        this.geo.set([...init.geo]);
        this.ageMinInput.set(init.ageMin);
        this.ageMaxInput.set(init.ageMax);
        this.gender.set(init.genders?.includes(1) && !init.genders.includes(2) ? 'men' : init.genders?.includes(2) && !init.genders.includes(1) ? 'women' : 'all');
        this.interests.set([...init.interests]);
      },
      { allowSignalWrites: true },
    );

    this.querySubject
      .pipe(
        debounceTime(SEARCH_DEBOUNCE_MS),
        distinctUntilChanged(),
        switchMap((q) => {
          if (q.trim().length < MIN_QUERY_LEN) {
            this.searching.set(false);
            return of<readonly GeoSearchResultOutput[]>([]);
          }
          this.searching.set(true);
          return this.api.searchGeo(this.accountId(), q.trim()).pipe(catchError(() => of<readonly GeoSearchResultOutput[]>([])));
        }),
        takeUntilDestroyed(),
      )
      .subscribe((r) => {
        this.searching.set(false);
        this.searched.set(true);
        this.results.set(r);
      });

    this.interestQuerySubject
      .pipe(
        debounceTime(SEARCH_DEBOUNCE_MS),
        distinctUntilChanged(),
        switchMap((q) => {
          if (q.trim().length < MIN_QUERY_LEN) {
            this.interestSearching.set(false);
            return of<readonly InterestSearchResultOutput[]>([]);
          }
          this.interestSearching.set(true);
          return this.api.searchInterests(this.accountId(), q.trim()).pipe(catchError(() => of<readonly InterestSearchResultOutput[]>([])));
        }),
        takeUntilDestroyed(),
      )
      .subscribe((r) => {
        this.interestSearching.set(false);
        this.interestSearched.set(true);
        this.interestResults.set(r);
      });

    // alcance estimado (Slice 7): recalcula debounced a cada mudança do público. Erro/estimativa
    // ausente → some a nota (enriquecimento, nunca bloqueia). interesses = 1 grupo OR no editor.
    this.reachSubject
      .pipe(
        debounceTime(SEARCH_DEBOUNCE_MS),
        switchMap((s) => {
          if (s.geo.length === 0) {
            this.estimating.set(false);
            return of<{ note: string | null }>({ note: null });
          }
          this.estimating.set(true);
          return this.api
            .estimateDelivery(this.accountId(), this.draftId(), {
              geo: s.geo.map((g) => ({ key: g.key, name: g.name, kind: g.kind })),
              ...(s.ageMin != null ? { ageMin: s.ageMin } : {}),
              ...(s.ageMax != null ? { ageMax: s.ageMax } : {}),
              ...(s.genders ? { genders: [...s.genders] } : {}),
              ...(s.interests.length > 0 ? { interestGroups: [s.interests.map((i) => ({ id: i.id, name: i.name }))] } : {}),
            })
            .pipe(catchError(() => of<{ note: string | null }>({ note: null })));
        }),
        takeUntilDestroyed(),
      )
      .subscribe((r) => {
        this.estimating.set(false);
        this.reach.set(r.note);
      });
  }

  protected onQueryChange(q: string): void {
    this.querySubject.next(q);
  }

  protected addGeo(r: GeoSearchResultOutput): void {
    if (this.geo().some((g) => g.key === r.key)) return;
    this.geo.update((list) => [...list, { key: r.key, name: r.name, kind: r.kind }]);
    this.query.set('');
    this.results.set([]);
    this.searched.set(false);
    this.emitState();
  }

  protected removeGeo(key: string): void {
    this.geo.update((list) => list.filter((g) => g.key !== key));
    this.emitState();
  }

  protected setGender(value: string | string[]): void {
    const v = Array.isArray(value) ? value[0] : value;
    if (v === 'all' || v === 'men' || v === 'women') {
      this.gender.set(v);
      this.emitState();
    }
  }

  protected kindLabel(kind: 'country' | 'region' | 'city'): string {
    return kind === 'country' ? 'país' : kind === 'region' ? 'região' : 'cidade';
  }

  protected onInterestQueryChange(q: string): void {
    this.interestQuerySubject.next(q);
  }

  protected addInterest(r: InterestSearchResultOutput): void {
    if (this.interests().some((i) => i.id === r.id)) return;
    this.interests.update((list) => [...list, { id: r.id, name: r.name }]);
    this.interestQuery.set('');
    this.interestResults.set([]);
    this.interestSearched.set(false);
    this.emitState();
  }

  protected removeInterest(id: string): void {
    this.interests.update((list) => list.filter((i) => i.id !== id));
    this.emitState();
  }

  protected emitState(): void {
    const genders: (1 | 2)[] | null = this.gender() === 'men' ? [1] : this.gender() === 'women' ? [2] : null;
    const state: ExplicitAudienceState = {
      geo: this.geo(),
      ageMin: this.ageMinInput(),
      ageMax: this.ageMaxInput(),
      genders,
      interests: this.interests(),
    };
    this.reachSubject.next(state);
    this.stateChange.emit({
      geo: this.geo(),
      ageMin: this.ageMinInput(),
      ageMax: this.ageMaxInput(),
      genders,
      interests: this.interests(),
    });
  }
}
