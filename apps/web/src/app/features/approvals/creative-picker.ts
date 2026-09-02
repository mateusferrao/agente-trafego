import { ChangeDetectionStrategy, Component, type OnInit, computed, inject, input, output, signal } from '@angular/core';
import { catchError, forkJoin, of } from 'rxjs';
import { UiInput } from '@ui';
import { DraftsApiService } from '@core/api/drafts-api.service';
import type { CreativeAssetOutput, ServingCreativeOutput, SetDraftCreativeInput } from '@core/api/generated';

/** Quantos anúncios mostrar antes do "ver mais"; e a partir de quantos aparece a busca. */
const SERVING_PAGE = 12;
const SEARCH_THRESHOLD = 12;

/**
 * Picker "trocar criativo" (Fatia 7): escolhe um criativo pra um rascunho from_scratch, de DUAS
 * fontes — anúncios que já veiculam na conta (reuse ao vivo, só vídeo hoje) + a biblioteca de
 * uploads (imagem com preview; vídeo com selo). Presentacional: carrega as duas listas e emite a
 * escolha DISCRIMINADA (`{kind:'serving',adId}` | `{kind:'asset',assetId}`); o pai persiste. Reuse
 * de anúncio de IMAGEM ao vivo = fast-follow (falta image_hash).
 */
@Component({
  selector: 'app-creative-picker',
  standalone: true,
  imports: [UiInput],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="flex flex-col gap-3 rounded-md border border-line bg-soft p-3">
      <div class="flex items-center justify-between">
        <span class="text-xs font-medium text-ink">Trocar criativo</span>
        <button type="button" class="text-xs text-muted hover:text-ink" (click)="cancel.emit()">Fechar</button>
      </div>

      @if (failed()) {
        <p class="text-xs text-muted">Não consegui carregar os criativos. Feche e tente de novo.</p>
      } @else if (loaded() && serving().length === 0 && libraryReady().length === 0) {
        <p class="text-xs text-muted">
          Ainda não tenho criativos pra oferecer nesta conta. Rode uma análise (que eu capturo os anúncios que veiculam)
          ou me mande um criativo no WhatsApp / suba na aba Criativos.
        </p>
      } @else {
        @if (serving().length > 0) {
          <div class="flex flex-col gap-1.5">
            <span class="text-[11px] font-medium uppercase tracking-wide text-muted">Anúncios da conta</span>
            @if (serving().length > SEARCH_THRESHOLD) {
              <input
                appInput
                class="w-full"
                type="search"
                placeholder="Buscar por título ou texto…"
                [value]="search()"
                (input)="onSearch($event)"
              />
            }
            <ul class="grid grid-cols-[repeat(auto-fill,minmax(84px,1fr))] gap-2">
              @for (s of visibleServing(); track s.adId; let i = $index) {
                <li>
                  <button
                    type="button"
                    class="block w-full overflow-hidden rounded-md border border-line hover:border-accent focus:border-accent"
                    [disabled]="picking()"
                    (click)="pick.emit({ kind: 'serving', adId: s.adId })"
                    [attr.aria-label]="'Reusar o anúncio ' + (s.title || (i + 1))"
                  >
                    <span class="relative flex aspect-square items-center justify-center bg-panel">
                      @if (s.thumbnailUrl && !broken().has('s:' + s.adId)) {
                        <img [src]="s.thumbnailUrl" alt="" class="h-full w-full object-cover" loading="lazy" (error)="onImgError('s:' + s.adId)" />
                      } @else {
                        <span class="px-1 text-center text-[11px] text-muted">sem preview</span>
                      }
                      <span class="absolute bottom-0.5 right-0.5 rounded bg-ink/70 px-1 text-[9px] text-primary-ink">{{ s.format === 'video' ? 'vídeo' : 'imagem' }}</span>
                    </span>
                  </button>
                </li>
              }
            </ul>
            @if (filteredServing().length === 0) {
              <span class="text-[11px] text-muted">Nenhum anúncio bate com “{{ search() }}”.</span>
            } @else if (filteredServing().length > visibleServing().length) {
              <button type="button" class="self-start text-xs text-accent hover:underline" (click)="showMore()">
                Ver mais ({{ filteredServing().length - visibleServing().length }})
              </button>
            }
          </div>
        }

        @if (libraryReady().length > 0) {
          <div class="flex flex-col gap-1.5">
            <span class="text-[11px] font-medium uppercase tracking-wide text-muted">Sua biblioteca</span>
            <ul class="grid grid-cols-[repeat(auto-fill,minmax(84px,1fr))] gap-2">
              @for (a of libraryReady(); track a.id; let i = $index) {
                <li>
                  <button
                    type="button"
                    class="block w-full overflow-hidden rounded-md border border-line hover:border-accent focus:border-accent"
                    [disabled]="picking()"
                    (click)="pick.emit({ kind: 'asset', assetId: a.id })"
                    [attr.aria-label]="'Usar o criativo ' + (i + 1) + ' da biblioteca'"
                  >
                    <span class="relative flex aspect-square items-center justify-center bg-panel">
                      @if (a.format === 'image' && !broken().has('a:' + a.id)) {
                        <img [src]="blobUrl(a)" alt="" class="h-full w-full object-cover" loading="lazy" (error)="onImgError('a:' + a.id)" />
                      } @else {
                        <span class="px-1 text-center text-[11px] text-muted">{{ a.format === 'video' ? 'vídeo' : 'sem preview' }}</span>
                      }
                    </span>
                  </button>
                </li>
              }
            </ul>
          </div>
        }
      }
    </div>
  `,
})
export class CreativePicker implements OnInit {
  private readonly api = inject(DraftsApiService);

  readonly accountId = input.required<string>();
  /** criativo escolhido — DISCRIMINADO (biblioteca × reuse ao vivo). */
  readonly pick = output<SetDraftCreativeInput>();
  readonly cancel = output<void>();
  /** o pai desabilita a grade enquanto persiste a troca. */
  readonly picking = input<boolean>(false);

  protected readonly assets = signal<readonly CreativeAssetOutput[]>([]);
  protected readonly serving = signal<readonly ServingCreativeOutput[]>([]);
  protected readonly loaded = signal(false);
  protected readonly failed = signal(false);
  protected readonly broken = signal<ReadonlySet<string>>(new Set());
  /** busca + truncamento do picker (contas com muitos criativos — Slice 12). */
  protected readonly search = signal('');
  protected readonly servingLimit = signal(SERVING_PAGE);
  protected readonly SEARCH_THRESHOLD = SEARCH_THRESHOLD;

  /** biblioteca escolhível = pronta (imagem com preview; vídeo com selo). */
  protected readonly libraryReady = computed(() => this.assets().filter((a) => a.status === 'ready'));

  /** anúncios veiculando filtrados pela busca (título/copy). */
  protected readonly filteredServing = computed(() => {
    const q = this.search().toLowerCase().trim();
    if (!q) return this.serving();
    return this.serving().filter(
      (s) => (s.title ?? '').toLowerCase().includes(q) || (s.copy ?? '').toLowerCase().includes(q),
    );
  });
  /** truncado ao limite atual (o "ver mais" aumenta). */
  protected readonly visibleServing = computed(() => this.filteredServing().slice(0, this.servingLimit()));

  protected onSearch(event: Event): void {
    this.search.set((event.target as HTMLInputElement).value);
    this.servingLimit.set(SERVING_PAGE); // nova busca → reinicia o truncamento
  }
  protected showMore(): void {
    this.servingLimit.update((n) => n + SERVING_PAGE);
  }

  protected blobUrl(a: CreativeAssetOutput): string {
    return this.api.creativeBlobUrl(this.accountId(), a.id);
  }
  protected onImgError(key: string): void {
    this.broken.update((s) => new Set(s).add(key));
  }

  ngOnInit(): void {
    // degrada POR FONTE: o reuse ao vivo (Meta) é mais frágil que a biblioteca local — um hiccup
    // no serving não pode derrubar o picker todo (reuso-primeiro). Só falha se AMBAS caírem.
    forkJoin({
      library: this.api.listCreatives(this.accountId()).pipe(catchError(() => of(null))),
      serving: this.api.listServingCreatives(this.accountId()).pipe(catchError(() => of(null))),
    }).subscribe(({ library, serving }) => {
      this.assets.set(library ?? []);
      this.serving.set(serving ?? []);
      this.loaded.set(true);
      if (library === null && serving === null) this.failed.set(true);
    });
  }
}
