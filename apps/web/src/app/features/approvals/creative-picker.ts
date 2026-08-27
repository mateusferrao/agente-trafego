import { ChangeDetectionStrategy, Component, type OnInit, inject, input, output, signal } from '@angular/core';
import { DraftsApiService } from '@core/api/drafts-api.service';
import type { CreativeAssetOutput } from '@core/api/generated';

/**
 * Picker "trocar criativo" (Fatia 7): escolhe um asset da biblioteca da conta pra um rascunho
 * from_scratch. Presentacional — carrega a biblioteca (só imagem pronta, com preview via a rota
 * de blob) e emite o assetId escolhido; o pai persiste (setDraftCreative). Upload segue na aba
 * Criativos (aqui só reusa o que já existe).
 */
@Component({
  selector: 'app-creative-picker',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="flex flex-col gap-2 rounded-md border border-line bg-soft p-3">
      <div class="flex items-center justify-between">
        <span class="text-xs font-medium text-ink">Trocar criativo</span>
        <button type="button" class="text-xs text-muted hover:text-ink" (click)="cancel.emit()">Fechar</button>
      </div>
      @if (failed()) {
        <p class="text-xs text-muted">Não consegui carregar os criativos. Feche e tente de novo.</p>
      } @else if (loaded() && ready().length === 0) {
        <p class="text-xs text-muted">Nenhuma imagem pronta na biblioteca ainda. Suba uma na aba Criativos.</p>
      } @else {
        <ul class="grid grid-cols-3 gap-2 sm:grid-cols-4">
          @for (a of ready(); track a.id; let i = $index) {
            <li>
              <button
                type="button"
                class="block w-full overflow-hidden rounded-md border border-line hover:border-accent focus:border-accent"
                [disabled]="picking()"
                (click)="pick.emit(a.id)"
                [attr.aria-label]="'Usar o criativo ' + (i + 1) + ' (' + (a.origin === 'upload' ? 'enviado' : 'da conta') + ')'"
              >
                <span class="flex aspect-square items-center justify-center bg-panel">
                  @if (!broken().has(a.id)) {
                    <img
                      [src]="blobUrl(a)"
                      alt=""
                      class="h-full w-full object-cover"
                      loading="lazy"
                      (error)="onImgError(a.id)"
                    />
                  } @else {
                    <span class="px-1 text-center text-[11px] text-muted">sem preview</span>
                  }
                </span>
              </button>
            </li>
          }
        </ul>
      }
    </div>
  `,
})
export class CreativePicker implements OnInit {
  private readonly api = inject(DraftsApiService);

  readonly accountId = input.required<string>();
  /** id do asset escolhido. */
  readonly pick = output<string>();
  readonly cancel = output<void>();
  /** o pai desabilita a grade enquanto persiste a troca. */
  readonly picking = input<boolean>(false);

  protected readonly assets = signal<readonly CreativeAssetOutput[]>([]);
  protected readonly loaded = signal(false);
  protected readonly failed = signal(false);
  protected readonly broken = signal<ReadonlySet<string>>(new Set());

  /** só imagem pronta é escolhível (vídeo/pending não renderiza preview nem sobe fiel ainda). */
  protected ready(): readonly CreativeAssetOutput[] {
    return this.assets().filter((a) => a.format === 'image' && a.status === 'ready');
  }
  protected blobUrl(a: CreativeAssetOutput): string {
    return this.api.creativeBlobUrl(this.accountId(), a.id);
  }
  protected onImgError(id: string): void {
    this.broken.update((s) => new Set(s).add(id));
  }

  ngOnInit(): void {
    this.api.listCreatives(this.accountId()).subscribe({
      next: (rows) => {
        this.assets.set(rows);
        this.loaded.set(true);
      },
      error: () => {
        this.loaded.set(true);
        this.failed.set(true);
      },
    });
  }
}
