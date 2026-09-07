import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  type WritableSignal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import type { Observable } from 'rxjs';
import { Subject } from 'rxjs';
import { catchError, debounceTime, distinctUntilChanged, groupBy, map, mergeMap, switchMap, of } from 'rxjs';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { UiBadge, UiButton, UiInput, UiToggleGroup, UiToggleGroupItem } from '@ui';
import { DraftsApiService } from '@core/api/drafts-api.service';
import type {
  AudienceOutput,
  DeliveryEstimateInput,
  GeoSearchResultOutput,
  InterestSearchResultOutput,
} from '@core/api/generated';

/** Unidade de distância única do público — o raio no site é sempre em km (a Meta aceita km). Exportada
 *  p/ o painel-pai reusar no mapeamento do PATCH (sem literal duplicado). */
export const KM = 'kilometer' as const;
const SEARCH_DEBOUNCE_MS = 300;
/** Abaixo disso não busca (poupa chamada por cada tecla de 1-2 letras — sem resultado útil ainda). */
const MIN_QUERY_LEN = 2;
/** Teto de resultados no filtro local de públicos salvos (lista pode ser grande). */
const MAX_AUDIENCE_MATCHES = 8;

/** Um interesse/comportamento escolhido (id resolvido pelo autocomplete + rótulo legível). */
interface TermItem {
  id: string;
  name: string;
}

/** Um grupo de termos (chips OR); entre grupos vale AND. `uid` = id local estável pro `@for`. */
interface TermGroup {
  uid: number;
  items: TermItem[];
}

/**
 * Estado COMPLETO do público explícito — espelha `TargetingSpec.explicit` (Fase 1 + Fase 2 + Slice 8).
 * O editor emite isto inteiro a cada mudança; o painel-pai manda pro backend como SUBSTITUIÇÃO total
 * (nada de diff). O site nunca manda nome livre — só ids/keys já resolvidos pelo autocomplete.
 */
export interface ExplicitAudienceState {
  geo: readonly {
    key: string;
    name: string;
    kind: 'country' | 'region' | 'city';
    radius: number | null;
    distanceUnit: 'mile' | 'kilometer' | null;
  }[];
  radiusAreas: readonly { address: string; radius: number; distanceUnit: 'mile' | 'kilometer' }[];
  ageMin: number | null;
  ageMax: number | null;
  genders: readonly (1 | 2)[] | null;
  interestGroups: readonly (readonly { id: string; name: string }[])[];
  behaviorGroups: readonly (readonly { id: string; name: string }[])[];
  customAudienceIncludeIds: readonly string[];
  customAudienceExcludeIds: readonly string[];
}

/** Público explícito no formato de WIRE (keys/ids já resolvidos) — shape comum do input de
 *  substituição total, servido tanto ao PATCH de rascunho quanto ao editAction de adjust_audience. */
export interface ExplicitAudienceWire {
  geo: { key: string; name: string; kind: 'country' | 'region' | 'city'; radius?: number; distanceUnit?: 'mile' | 'kilometer' }[];
  radiusAreas: { address: string; radius: number; distanceUnit: 'mile' | 'kilometer' }[];
  ageMin?: number;
  ageMax?: number;
  genders?: (1 | 2)[];
  interestGroups: { id: string; name: string }[][];
  behaviorGroups: { id: string; name: string }[][];
  customAudienceIncludeIds: string[];
  customAudienceExcludeIds: string[];
}

/**
 * Estado COMPLETO do editor → objeto de PÚBLICO explícito pro wire (substituição total; radius/
 * distanceUnit só quando houver; grupos/públicos sempre presentes, podem ser vazios). FONTE ÚNICA
 * do mapeamento — reusado pelo painel de rascunho E pelo card de ação adjust_audience (Fatia C).
 */
export function toExplicitAudienceWire(s: ExplicitAudienceState): ExplicitAudienceWire {
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

/**
 * Grupos de termos (interesses OU comportamentos) — chips OR dentro do grupo, AND entre grupos.
 * Encapsula estado + busca ao vivo (debounce/switchMap/catchError) por grupo, keyed por `uid` estável
 * (remover não reindexa). Não é Angular: `signal()`/`takeUntilDestroyed(destroyRef)` são autônomos.
 */
class TermSection {
  private uidSeq = 0;
  readonly groups = signal<TermGroup[]>([]);
  // Records começam vazios e só ganham a chave `[uid]` ao digitar/buscar — o tipo é honesto sobre
  // isso (`| undefined`), o que justifica os guardas `?? ''`/`?? []` no template (e cala o NG8102).
  readonly queries = signal<Record<number, string | undefined>>({});
  readonly results = signal<Record<number, readonly InterestSearchResultOutput[] | undefined>>({});
  readonly searching = signal<Record<number, boolean>>({});
  readonly searched = signal<Record<number, boolean>>({});
  private readonly subject = new Subject<{ uid: number; q: string }>();

  constructor(
    private readonly search: (q: string) => Observable<readonly InterestSearchResultOutput[]>,
    private readonly onChange: () => void,
    destroyRef: DestroyRef,
  ) {
    // um stream POR grupo (groupBy uid) — o switchMap só cancela buscas do MESMO grupo, então digitar
    // no grupo B nunca deixa o spinner do grupo A preso (cada uid mantém seu próprio searching/searched).
    this.subject
      .pipe(
        groupBy((x) => x.uid),
        mergeMap((byUid) =>
          byUid.pipe(
            debounceTime(SEARCH_DEBOUNCE_MS),
            distinctUntilChanged((a, b) => a.q === b.q),
            switchMap(({ uid, q }) => {
              if (q.trim().length < MIN_QUERY_LEN) {
                this.set(this.searching, uid, false);
                return of({ uid, r: [] as readonly InterestSearchResultOutput[] });
              }
              this.set(this.searching, uid, true);
              return this.search(q.trim()).pipe(
                map((r) => ({ uid, r })),
                catchError(() => of({ uid, r: [] as readonly InterestSearchResultOutput[] })),
              );
            }),
          ),
        ),
        takeUntilDestroyed(destroyRef),
      )
      .subscribe(({ uid, r }) => {
        this.set(this.searching, uid, false);
        this.set(this.searched, uid, true);
        this.results.update((m) => ({ ...m, [uid]: r }));
      });
  }

  /** Semeia os grupos existentes + garante um grupo vazio no fim (input pronto pra digitar). */
  seed(groups: readonly (readonly TermItem[])[]): void {
    const seeded = groups
      .filter((g) => g.length > 0)
      .map((g) => ({ uid: this.uidSeq++, items: g.map((i) => ({ id: i.id, name: i.name })) }));
    this.groups.set(this.withTrailingEmpty(seeded));
  }

  addGroup(): void {
    if (!this.canAddGroup()) return;
    this.groups.update((gs) => [...gs, { uid: this.uidSeq++, items: [] }]);
  }

  /** Só deixa criar novo grupo quando não há um vazio esperando (evita grupos ociosos). */
  canAddGroup(): boolean {
    return this.groups().every((g) => g.items.length > 0);
  }

  onQueryChange(uid: number, q: string): void {
    this.set(this.queries, uid, q);
    this.subject.next({ uid, q });
  }

  addItem(uid: number, r: InterestSearchResultOutput): void {
    let changed = false;
    this.groups.update((gs) =>
      gs.map((g) => {
        if (g.uid !== uid || g.items.some((i) => i.id === r.id)) return g;
        changed = true;
        return { ...g, items: [...g.items, { id: r.id, name: r.name }] };
      }),
    );
    this.set(this.queries, uid, '');
    this.results.update((m) => ({ ...m, [uid]: [] }));
    this.set(this.searched, uid, false);
    if (changed) this.onChange();
  }

  removeItem(uid: number, id: string): void {
    this.groups.update((gs) => {
      const mapped = gs.map((g) => (g.uid === uid ? { ...g, items: g.items.filter((i) => i.id !== id) } : g));
      return this.withTrailingEmpty(mapped.filter((g) => g.items.length > 0));
    });
    this.onChange();
  }

  /** Só os grupos preenchidos, no formato neutro do estado (grupos vazios não vão pro backend). */
  value(): { id: string; name: string }[][] {
    return this.groups()
      .filter((g) => g.items.length > 0)
      .map((g) => g.items.map((i) => ({ id: i.id, name: i.name })));
  }

  private withTrailingEmpty(gs: TermGroup[]): TermGroup[] {
    return gs.some((g) => g.items.length === 0) ? gs : [...gs, { uid: this.uidSeq++, items: [] }];
  }

  private set<T>(sig: WritableSignal<Record<number, T>>, uid: number, v: T): void {
    sig.update((m) => ({ ...m, [uid]: v }));
  }
}

/**
 * Bloco de grupos de termos (interesses/comportamentos) — presentacional puro sobre um `TermSection`.
 * Reusado nas duas seções: só muda o título/rótulo/placeholder e a função de busca (via `section`).
 */
@Component({
  selector: 'app-term-groups',
  standalone: true,
  imports: [FormsModule, UiInput, UiBadge, UiButton],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="flex flex-col gap-1.5">
      <span class="text-xs font-medium text-ink">{{ title() }}</span>
      <span class="text-[11px] text-muted">{{ hint() }}</span>
      @for (g of section().groups(); track g.uid; let gi = $index) {
        <div class="flex flex-col gap-1.5 rounded-md border border-line bg-app p-2.5">
          @if (gi > 0) {
            <span class="text-[10px] font-medium uppercase tracking-wide text-muted">e também</span>
          }
          @if (g.items.length > 0) {
            <ul class="flex flex-wrap gap-1.5">
              @for (i of g.items; track i.id) {
                <li>
                  <span appBadge tone="accent" class="pr-1">
                    {{ i.name }}
                    <button
                      type="button"
                      class="ml-0.5 rounded-full px-1 text-accent-strong/70 hover:text-accent-strong"
                      [attr.aria-label]="'Remover ' + i.name"
                      (click)="section().removeItem(g.uid, i.id)"
                    >
                      ×
                    </button>
                  </span>
                </li>
              }
            </ul>
          }
          <div class="relative">
            <input
              appInput
              class="w-full"
              type="search"
              [placeholder]="placeholder()"
              [ngModel]="section().queries()[g.uid] ?? ''"
              (ngModelChange)="section().onQueryChange(g.uid, $event)"
            />
            @if (section().searching()[g.uid]) {
              <span class="absolute right-2 top-1/2 -translate-y-1/2 text-[11px] text-muted">buscando…</span>
            }
            @if ((section().results()[g.uid] ?? []).length > 0) {
              <ul class="absolute z-10 mt-1 w-full overflow-hidden rounded-md border border-line bg-app shadow-md">
                @for (r of (section().results()[g.uid] ?? []); track r.id) {
                  <li>
                    <button
                      type="button"
                      class="flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-sm text-ink hover:bg-soft"
                      (click)="section().addItem(g.uid, r)"
                    >
                      <span>{{ r.name }}</span>
                      @if (metaLine(r)) {
                        <span class="text-[11px] text-muted">{{ metaLine(r) }}</span>
                      }
                    </button>
                  </li>
                }
              </ul>
            } @else if (
              (section().queries()[g.uid] ?? '').trim().length >= MIN_QUERY_LEN &&
              section().searched()[g.uid] &&
              !section().searching()[g.uid]
            ) {
              <span class="mt-1 block text-[11px] text-muted">Nada encontrado pra “{{ section().queries()[g.uid] }}”.</span>
            }
          </div>
        </div>
      }
      <button
        appButton
        variant="ghost"
        size="sm"
        type="button"
        class="self-start"
        [disabled]="!section().canAddGroup()"
        (click)="section().addGroup()"
      >
        {{ addLabel() }}
      </button>
    </div>
  `,
})
export class TermGroupsEditor {
  readonly section = input.required<TermSection>();
  readonly title = input.required<string>();
  readonly hint = input.required<string>();
  readonly placeholder = input.required<string>();
  readonly addLabel = input.required<string>();
  protected readonly MIN_QUERY_LEN = MIN_QUERY_LEN;

  /** Linha secundária do resultado: tamanho de público + trilha da categoria (' · '), o que houver. */
  protected metaLine(r: InterestSearchResultOutput): string {
    const parts: string[] = [];
    const size = this.audienceSizeLabel(r.audienceSize);
    if (size) parts.push(size);
    if (r.path && r.path.length > 0) parts.push(r.path.join(' > '));
    return parts.join(' · ');
  }

  /** Tamanho de público humanizado em PT — mi/mil/pessoas; 1 casa só abaixo de 10 mi; 0/null → ''. */
  private audienceSizeLabel(size: number | null): string {
    if (!size || size <= 0) return '';
    if (size >= 1_000_000) {
      const mi = size / 1_000_000;
      const value = mi < 10 ? mi.toLocaleString('pt-BR', { maximumFractionDigits: 1 }) : String(Math.round(mi));
      return `~${value} mi pessoas`;
    }
    if (size >= 1_000) return `~${Math.round(size / 1_000)} mil pessoas`;
    return `~${Math.round(size)} pessoas`;
  }
}

/**
 * Editor de público EXPLÍCITO completo (Fatia 7, Slice 8) — geo + raio (chip e endereço), idade,
 * gênero, interesses e comportamentos em GRUPOS (OR dentro, AND entre) e públicos salvos
 * (incluir/excluir). Presentacional: mantém o estado local e emite o estado COMPLETO a cada mudança
 * (`stateChange`); o painel-pai (`draft-edit-panel`) inclui como substituição total no PATCH — não
 * persiste sozinho. Buscas ao vivo degradam em silêncio (erro → lista vazia, nunca quebra a UI).
 */
@Component({
  selector: 'app-geo-audience-editor',
  standalone: true,
  imports: [FormsModule, UiInput, UiToggleGroup, UiToggleGroupItem, UiBadge, UiButton, TermGroupsEditor],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="flex flex-col gap-4 rounded-md border border-line bg-panel p-3">
      <!-- Localização + raio por cidade/região -->
      <div class="flex flex-col gap-1.5">
        <span class="text-xs font-medium text-ink">Localização</span>
        @if (geo().length > 0) {
          <ul class="flex flex-col gap-1.5">
            @for (g of geo(); track g.key) {
              <li class="flex items-center gap-1.5">
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
                @if (g.kind === 'city') {
                  <input
                    appInput
                    class="w-28"
                    type="number"
                    min="1"
                    step="1"
                    placeholder="raio (km)"
                    [ngModel]="g.radius"
                    (ngModelChange)="setGeoRadius(g.key, $event)"
                  />
                }
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
                    class="flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-sm text-ink hover:bg-soft"
                    (click)="addGeo(r)"
                  >
                    <span>{{ r.name }}</span>
                    <span class="text-[11px] text-muted">{{ geoMeta(r) }}</span>
                  </button>
                </li>
              }
            </ul>
          } @else if (query().trim().length >= MIN_QUERY_LEN && searched() && !searching()) {
            <span class="mt-1 block text-[11px] text-muted">Nenhum lugar encontrado pra “{{ query() }}”.</span>
          }
        </div>
      </div>

      <!-- Raio por endereço -->
      <div class="flex flex-col gap-1.5">
        <span class="text-xs font-medium text-ink">Raio por endereço</span>
        @if (radiusAreas().length > 0) {
          <ul class="flex flex-wrap gap-1.5">
            @for (a of radiusAreas(); track $index) {
              <li>
                <span appBadge tone="accent" class="pr-1">
                  {{ a.address }} · {{ a.radius }} km
                  <button
                    type="button"
                    class="ml-0.5 rounded-full px-1 text-accent-strong/70 hover:text-accent-strong"
                    [attr.aria-label]="'Remover ' + a.address"
                    (click)="removeRadiusArea($index)"
                  >
                    ×
                  </button>
                </span>
              </li>
            }
          </ul>
        }
        <div class="flex flex-col gap-2 sm:flex-row sm:items-center">
          <input appInput class="w-full sm:flex-1" type="text" placeholder="Endereço" [(ngModel)]="addressInput" />
          <input appInput class="w-full sm:w-28" type="number" min="1" step="1" placeholder="raio (km)" [(ngModel)]="radiusInput" />
          <button appButton variant="ghost" size="sm" type="button" class="shrink-0" [disabled]="!canAddRadiusArea()" (click)="addRadiusArea()">
            Adicionar
          </button>
        </div>
      </div>

      <!-- Idade + gênero -->
      <div class="flex flex-col gap-4 sm:flex-row sm:items-start">
        <div class="flex flex-col gap-1 sm:flex-1">
          <span class="text-xs font-medium text-ink">Idade</span>
          <div class="flex items-center gap-2">
            <input appInput class="w-full" type="number" min="13" max="65" placeholder="mín." [(ngModel)]="ageMinInput" (ngModelChange)="emitState()" />
            <span class="text-xs text-muted">até</span>
            <input appInput class="w-full" type="number" min="13" max="65" placeholder="máx." [(ngModel)]="ageMaxInput" (ngModelChange)="emitState()" />
          </div>
          @if (ageInvalid()) {
            <span class="text-[11px] text-muted">A idade mínima está maior que a máxima — ajuste antes de salvar.</span>
          }
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

      <!-- Interesses (grupos) -->
      <app-term-groups
        [section]="interest"
        title="Interesses"
        hint="Dentro de um grupo vale qualquer um (ou); entre grupos, precisa de todos (e)."
        placeholder="Adicionar interesse (ex: estética, pets)…"
        addLabel="+ E também (novo grupo)"
      />

      <!-- Comportamentos (grupos) -->
      <app-term-groups
        [section]="behavior"
        title="Comportamentos"
        hint="Dentro de um grupo vale qualquer um (ou); entre grupos, precisa de todos (e)."
        placeholder="Adicionar comportamento…"
        addLabel="+ E também (novo grupo)"
      />

      <!-- Públicos salvos: incluir / excluir -->
      <div class="flex flex-col gap-3">
        <span class="text-xs font-medium text-ink">Públicos salvos</span>
        @if (audiences().length === 0) {
          <span class="text-[11px] text-muted">Nenhum público salvo nesta conta.</span>
        } @else {
          <div class="flex flex-col gap-4 sm:flex-row sm:items-start">
            <!-- Incluir -->
            <div class="flex flex-col gap-1.5 sm:flex-1">
              <span class="text-[11px] font-medium uppercase tracking-wide text-muted">Incluir</span>
              @if (includeIds().length > 0) {
                <ul class="flex flex-wrap gap-1.5">
                  @for (id of includeIds(); track id) {
                    <li>
                      <span appBadge tone="accent" class="pr-1">
                        {{ audienceName(id) }}
                        <button type="button" class="ml-0.5 rounded-full px-1 text-accent-strong/70 hover:text-accent-strong" [attr.aria-label]="'Remover ' + audienceName(id)" (click)="removeInclude(id)">×</button>
                      </span>
                    </li>
                  }
                </ul>
              }
              <div class="relative">
                <input appInput class="w-full" type="search" placeholder="Filtrar seus públicos…" [ngModel]="includeFilter()" (ngModelChange)="includeFilter.set($event)" />
                @if (includeMatches().length > 0) {
                  <ul class="absolute z-10 mt-1 w-full overflow-hidden rounded-md border border-line bg-app shadow-md">
                    @for (a of includeMatches(); track a.id) {
                      <li>
                        <button type="button" class="flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-sm text-ink hover:bg-soft" (click)="addInclude(a.id)">
                          <span>{{ a.name }}</span>
                          @if (a.isLookalike) {
                            <span class="text-[11px] text-accent-strong">semelhante</span>
                          }
                        </button>
                      </li>
                    }
                  </ul>
                }
              </div>
            </div>
            <!-- Excluir -->
            <div class="flex flex-col gap-1.5 sm:flex-1">
              <span class="text-[11px] font-medium uppercase tracking-wide text-muted">Excluir</span>
              @if (excludeIds().length > 0) {
                <ul class="flex flex-wrap gap-1.5">
                  @for (id of excludeIds(); track id) {
                    <li>
                      <span appBadge tone="accent" class="pr-1">
                        {{ audienceName(id) }}
                        <button type="button" class="ml-0.5 rounded-full px-1 text-accent-strong/70 hover:text-accent-strong" [attr.aria-label]="'Remover ' + audienceName(id)" (click)="removeExclude(id)">×</button>
                      </span>
                    </li>
                  }
                </ul>
              }
              <div class="relative">
                <input appInput class="w-full" type="search" placeholder="Filtrar seus públicos…" [ngModel]="excludeFilter()" (ngModelChange)="excludeFilter.set($event)" />
                @if (excludeMatches().length > 0) {
                  <ul class="absolute z-10 mt-1 w-full overflow-hidden rounded-md border border-line bg-app shadow-md">
                    @for (a of excludeMatches(); track a.id) {
                      <li>
                        <button type="button" class="flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-sm text-ink hover:bg-soft" (click)="addExclude(a.id)">
                          <span>{{ a.name }}</span>
                          @if (a.isLookalike) {
                            <span class="text-[11px] text-accent-strong">semelhante</span>
                          }
                        </button>
                      </li>
                    }
                  </ul>
                }
              </div>
            </div>
          </div>
        }
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
  private readonly destroyRef = inject(DestroyRef);
  private readonly querySubject = new Subject<string>();
  private readonly reachSubject = new Subject<ExplicitAudienceState>();

  readonly accountId = input.required<string>();
  /** id do rascunho — usado só p/ estimar o alcance (Slice 7); o objetivo/pixel vêm dele no servidor.
   *  `null` (ex: editando o público de uma AÇÃO adjust_audience, Fatia C) → sem preview de alcance. */
  readonly draftId = input<string | null>(null);
  readonly initial = input.required<ExplicitAudienceState>();
  /** emite o estado COMPLETO a cada mudança — o pai manda como substituição total no PATCH do Salvar. */
  readonly stateChange = output<ExplicitAudienceState>();

  protected readonly MIN_QUERY_LEN = MIN_QUERY_LEN;

  // nota de alcance estimado (Slice 7).
  protected readonly reach = signal<string | null>(null);
  protected readonly estimating = signal(false);

  // geo + raio.
  protected readonly geo = signal<ExplicitAudienceState['geo']>([]);
  protected readonly query = signal('');
  protected readonly results = signal<readonly GeoSearchResultOutput[]>([]);
  protected readonly searching = signal(false);
  protected readonly searched = signal(false);

  // raio por endereço.
  protected readonly radiusAreas = signal<ExplicitAudienceState['radiusAreas']>([]);
  protected readonly addressInput = signal('');
  protected readonly radiusInput = signal<number | null>(null);

  // idade + gênero.
  protected readonly ageMinInput = signal<number | null>(null);
  protected readonly ageMaxInput = signal<number | null>(null);
  protected readonly gender = signal<'all' | 'men' | 'women'>('all');
  protected readonly ageInvalid = computed(() => {
    const min = this.ageMinInput();
    const max = this.ageMaxInput();
    return min != null && max != null && min > max;
  });

  // interesses + comportamentos (grupos).
  protected readonly interest = new TermSection((q) => this.api.searchInterests(this.accountId(), q), () => this.emitState(), this.destroyRef);
  protected readonly behavior = new TermSection((q) => this.api.searchBehaviors(this.accountId(), q), () => this.emitState(), this.destroyRef);

  // públicos salvos.
  protected readonly audiences = signal<readonly AudienceOutput[]>([]);
  protected readonly includeIds = signal<readonly string[]>([]);
  protected readonly excludeIds = signal<readonly string[]>([]);
  protected readonly includeFilter = signal('');
  protected readonly excludeFilter = signal('');
  // exclui do dropdown de cada lista os já escolhidos na lista OPOSTA — o mesmo público não pode estar
  // em incluir E excluir (targeting contraditório).
  protected readonly includeMatches = computed(() => this.matchAudiences(this.includeFilter(), this.includeIds(), this.excludeIds()));
  protected readonly excludeMatches = computed(() => this.matchAudiences(this.excludeFilter(), this.excludeIds(), this.includeIds()));

  private seeded = false;

  constructor() {
    // inicializa do `initial()` UMA vez (o painel-pai não re-emite depois de montado) + carrega os
    // públicos salvos da conta uma vez. Lê `initial()`/`accountId()` p/ o effect trackear os inputs.
    effect(
      () => {
        const init = this.initial();
        const acc = this.accountId();
        if (this.seeded) return;
        this.seeded = true;
        this.geo.set([...init.geo]);
        this.radiusAreas.set([...init.radiusAreas]);
        this.ageMinInput.set(init.ageMin);
        this.ageMaxInput.set(init.ageMax);
        this.gender.set(this.genderFromState(init.genders));
        this.interest.seed(init.interestGroups);
        this.behavior.seed(init.behaviorGroups);
        this.includeIds.set([...init.customAudienceIncludeIds]);
        this.excludeIds.set([...init.customAudienceExcludeIds]);
        this.loadAudiences(acc);
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

    // alcance estimado (Slice 7): recalcula debounced a cada mudança. Só estima com geo OU raio por
    // endereço. Erro/estimativa ausente → some a nota (enriquecimento, nunca bloqueia).
    this.reachSubject
      .pipe(
        debounceTime(SEARCH_DEBOUNCE_MS),
        switchMap((s) => {
          const draftId = this.draftId();
          // sem rascunho (edição de público de uma AÇÃO) OU sem geo/raio → sem preview de alcance.
          if (!draftId || (s.geo.length === 0 && s.radiusAreas.length === 0)) {
            this.estimating.set(false);
            return of<{ note: string | null }>({ note: null });
          }
          this.estimating.set(true);
          return this.api
            .estimateDelivery(this.accountId(), draftId, this.toEstimateInput(s))
            .pipe(catchError(() => of<{ note: string | null }>({ note: null })));
        }),
        takeUntilDestroyed(),
      )
      .subscribe((r) => {
        this.estimating.set(false);
        this.reach.set(r.note);
      });
  }

  // ----- geo -----

  protected onQueryChange(q: string): void {
    this.querySubject.next(q);
  }

  protected addGeo(r: GeoSearchResultOutput): void {
    if (this.geo().some((g) => g.key === r.key)) return;
    this.geo.update((list) => [...list, { key: r.key, name: r.name, kind: r.kind, radius: null, distanceUnit: null }]);
    this.query.set('');
    this.results.set([]);
    this.searched.set(false);
    this.emitState();
  }

  protected removeGeo(key: string): void {
    this.geo.update((list) => list.filter((g) => g.key !== key));
    this.emitState();
  }

  /** Raio (km) por chip de cidade (a Meta só aceita raio em cidade) — número > 0 seta km; vazio limpa. */
  protected setGeoRadius(key: string, value: number | null): void {
    const radius = typeof value === 'number' && value > 0 ? value : null;
    this.geo.update((list) =>
      list.map((g) => (g.key === key ? { ...g, radius, distanceUnit: radius != null ? KM : null } : g)),
    );
    this.emitState();
  }

  protected geoMeta(r: GeoSearchResultOutput): string {
    return r.countryCode ? `${this.kindLabel(r.kind)} · ${r.countryCode}` : this.kindLabel(r.kind);
  }

  private kindLabel(kind: 'country' | 'region' | 'city'): string {
    return kind === 'country' ? 'país' : kind === 'region' ? 'região' : 'cidade';
  }

  // ----- raio por endereço -----

  protected canAddRadiusArea(): boolean {
    const radius = this.radiusInput();
    return this.addressInput().trim().length > 0 && typeof radius === 'number' && radius > 0;
  }

  protected addRadiusArea(): void {
    if (!this.canAddRadiusArea()) return;
    const address = this.addressInput().trim();
    const radius = this.radiusInput() as number;
    this.radiusAreas.update((list) => [...list, { address, radius, distanceUnit: KM }]);
    this.addressInput.set('');
    this.radiusInput.set(null);
    this.emitState();
  }

  protected removeRadiusArea(index: number): void {
    this.radiusAreas.update((list) => list.filter((_, i) => i !== index));
    this.emitState();
  }

  // ----- gênero -----

  protected setGender(value: string | string[]): void {
    const v = Array.isArray(value) ? value[0] : value;
    if (v === 'all' || v === 'men' || v === 'women') {
      this.gender.set(v);
      this.emitState();
    }
  }

  private genderFromState(genders: ExplicitAudienceState['genders']): 'all' | 'men' | 'women' {
    if (genders?.includes(1) && !genders.includes(2)) return 'men';
    if (genders?.includes(2) && !genders.includes(1)) return 'women';
    return 'all';
  }

  // ----- públicos salvos -----

  private loadAudiences(accountId: string): void {
    this.api
      .listAudiences(accountId)
      .pipe(
        catchError(() => of<AudienceOutput[]>([])),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe((list) => this.audiences.set(list));
  }

  protected audienceName(id: string): string {
    return this.audiences().find((a) => a.id === id)?.name ?? id;
  }

  private matchAudiences(filter: string, selected: readonly string[], opposite: readonly string[]): readonly AudienceOutput[] {
    const q = filter.trim().toLowerCase();
    if (q.length === 0) return [];
    return this.audiences()
      .filter((a) => !selected.includes(a.id) && !opposite.includes(a.id) && a.name.toLowerCase().includes(q))
      .slice(0, MAX_AUDIENCE_MATCHES);
  }

  protected addInclude(id: string): void {
    if (this.includeIds().includes(id)) return;
    this.includeIds.update((list) => [...list, id]);
    this.includeFilter.set('');
    this.emitState();
  }

  protected removeInclude(id: string): void {
    this.includeIds.update((list) => list.filter((x) => x !== id));
    this.emitState();
  }

  protected addExclude(id: string): void {
    if (this.excludeIds().includes(id)) return;
    this.excludeIds.update((list) => [...list, id]);
    this.excludeFilter.set('');
    this.emitState();
  }

  protected removeExclude(id: string): void {
    this.excludeIds.update((list) => list.filter((x) => x !== id));
    this.emitState();
  }

  // ----- estado -----

  protected emitState(): void {
    const state = this.snapshot();
    this.reachSubject.next(state);
    this.stateChange.emit(state);
  }

  private snapshot(): ExplicitAudienceState {
    const genders: (1 | 2)[] | null = this.gender() === 'men' ? [1] : this.gender() === 'women' ? [2] : null;
    // idade inválida (mín > máx) NÃO vai pro backend — emite ambos como null e o hint pede o ajuste;
    // assim nada inválido é criado, sem depender do 422.
    const invalidAge = this.ageInvalid();
    return {
      geo: this.geo(),
      radiusAreas: this.radiusAreas(),
      ageMin: invalidAge ? null : this.ageMinInput(),
      ageMax: invalidAge ? null : this.ageMaxInput(),
      genders,
      interestGroups: this.interest.value(),
      behaviorGroups: this.behavior.value(),
      customAudienceIncludeIds: this.includeIds(),
      customAudienceExcludeIds: this.excludeIds(),
    };
  }

  /** Mapeia o estado COMPLETO pro input de estimativa (radius/distanceUnit só quando houver). */
  private toEstimateInput(s: ExplicitAudienceState): DeliveryEstimateInput {
    return {
      geo: s.geo.map((g) => ({
        key: g.key,
        name: g.name,
        kind: g.kind,
        ...(g.radius != null ? { radius: g.radius, distanceUnit: g.distanceUnit ?? KM } : {}),
      })),
      ...(s.radiusAreas.length > 0 ? { radiusAreas: s.radiusAreas.map((a) => ({ address: a.address, radius: a.radius, distanceUnit: a.distanceUnit })) } : {}),
      ...(s.ageMin != null ? { ageMin: s.ageMin } : {}),
      ...(s.ageMax != null ? { ageMax: s.ageMax } : {}),
      ...(s.genders ? { genders: [...s.genders] } : {}),
      ...(s.interestGroups.length > 0 ? { interestGroups: s.interestGroups.map((g) => g.map((i) => ({ id: i.id, name: i.name }))) } : {}),
      ...(s.behaviorGroups.length > 0 ? { behaviorGroups: s.behaviorGroups.map((g) => g.map((i) => ({ id: i.id, name: i.name }))) } : {}),
      ...(s.customAudienceIncludeIds.length > 0 ? { customAudienceIncludeIds: [...s.customAudienceIncludeIds] } : {}),
      ...(s.customAudienceExcludeIds.length > 0 ? { customAudienceExcludeIds: [...s.customAudienceExcludeIds] } : {}),
    };
  }
}
