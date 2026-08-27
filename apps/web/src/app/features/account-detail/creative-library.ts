import { ChangeDetectionStrategy, Component, DestroyRef, type OnInit, inject, signal } from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import { toast } from 'ngx-sonner';
import { UiButton, UiEmptyState } from '@ui';
import { DraftsApiService } from '@core/api/drafts-api.service';
import type { CreativeAssetOutput } from '@core/api/generated';

/**
 * Biblioteca de criativos da conta (Fatia 7): assets reusáveis nos rascunhos. Origem
 * `reuse` (dos anúncios da conta) ou `upload` (aqui). O Roi nunca inventa mídia — reusa
 * o que existe ou o que você sobe. Upload → sobe pra Meta (image_hash) → asset pronto.
 */
@Component({
  selector: 'app-creative-library',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [UiButton, UiEmptyState],
  template: `
    <div class="flex flex-col gap-6">
      <div class="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 class="font-brand text-lg font-semibold text-ink">Criativos</h1>
          <p class="text-xs text-muted">Mídias reusáveis nos rascunhos de campanha. O agente reusa daqui — nunca inventa.</p>
        </div>
        <button type="button" appButton size="sm" [disabled]="uploading()" (click)="picker.click()">
          {{ uploading() ? 'Enviando…' : 'Subir criativo' }}
        </button>
        <input #picker type="file" accept="image/*,video/*" class="hidden" (change)="onFile($event)" />
      </div>

      @if (failed()) {
        <div class="flex flex-col items-start gap-2 rounded-lg border border-line bg-panel p-4 text-sm">
          <p class="text-ink">Não consegui carregar os criativos desta conta.</p>
          <button type="button" appButton variant="secondary" size="sm" (click)="load()">Tentar de novo</button>
        </div>
      } @else if (loaded() && assets().length === 0) {
        <app-ui-empty-state title="Nenhum criativo ainda" description="Suba uma imagem ou rode uma análise — os criativos dos seus anúncios entram aqui automaticamente." />
      } @else {
        <ul class="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          @for (a of assets(); track a.id) {
            <li class="flex flex-col gap-2 rounded-lg border border-line bg-panel p-3">
              <div class="flex aspect-square items-center justify-center overflow-hidden rounded-md bg-soft">
                @if (a.format === 'image' && a.status === 'ready' && !broken().has(a.id)) {
                  <img
                    [src]="blobUrl(a)"
                    [alt]="a.origin === 'upload' ? 'Criativo enviado' : 'Criativo da conta'"
                    class="h-full w-full object-cover"
                    loading="lazy"
                    (error)="onImgError(a.id)"
                  />
                } @else {
                  <span class="px-2 text-center text-xs text-muted">
                    {{ a.status === 'pending' ? 'processando…' : a.format === 'video' ? 'vídeo' : 'sem preview' }}
                  </span>
                }
              </div>
              <span class="flex items-center justify-between text-xs">
                <span class="font-medium text-ink">{{ a.origin === 'upload' ? 'Enviado' : 'Da conta' }}</span>
                <span class="text-muted">{{ formatLabel(a.format) }} · {{ statusLabel(a.status) }}</span>
              </span>
            </li>
          }
        </ul>
      }
    </div>
  `,
})
export class CreativeLibrary implements OnInit {
  private readonly api = inject(DraftsApiService);
  private readonly accountId = inject(ActivatedRoute).snapshot.paramMap.get('id') ?? '';
  private destroyed = false;
  /** evita cadeias de poll concorrentes (N uploads enquanto um vídeo processa). */
  private pollScheduled = false;

  constructor() {
    inject(DestroyRef).onDestroy(() => {
      this.destroyed = true;
    });
  }

  /** Cadência do re-load enquanto há vídeo `pending` (o poll do servidor flipa → ready/error). */
  private static readonly PENDING_POLL_MS = 6000;

  protected readonly assets = signal<readonly CreativeAssetOutput[]>([]);
  protected readonly loaded = signal(false);
  protected readonly failed = signal(false);
  protected readonly uploading = signal(false);
  /** ids cujo <img> falhou (blob 404 / ref drift) → cai no placeholder, nunca ícone quebrado. */
  protected readonly broken = signal<ReadonlySet<string>>(new Set());

  /** URL da rota autenticada de blob — reusa o builder do service (evita drift). */
  protected blobUrl(a: CreativeAssetOutput): string {
    return this.api.creativeBlobUrl(this.accountId, a.id);
  }
  protected onImgError(id: string): void {
    this.broken.update((s) => new Set(s).add(id));
  }

  protected statusLabel(s: CreativeAssetOutput['status']): string {
    return s === 'ready' ? 'pronto' : s === 'pending' ? 'processando' : 'erro';
  }

  protected formatLabel(f: CreativeAssetOutput['format']): string {
    return f === 'video' ? 'vídeo' : 'imagem';
  }

  ngOnInit(): void {
    this.load();
  }

  protected load(): void {
    this.failed.set(false);
    this.api.listCreatives(this.accountId).subscribe({
      next: (rows) => {
        this.assets.set(rows);
        this.loaded.set(true);
        // vídeo processa async no servidor → re-consulta enquanto houver `pending` (para quando
        // zerar). Feedback vivo: o card "processando" vira preview/erro sem recarregar a página.
        // `pollScheduled` garante UMA cadeia (uploads repetidos não abrem loops paralelos).
        if (!this.destroyed && !this.pollScheduled && rows.some((a) => a.status === 'pending')) {
          this.pollScheduled = true;
          setTimeout(() => {
            this.pollScheduled = false;
            if (!this.destroyed) this.load();
          }, CreativeLibrary.PENDING_POLL_MS);
        }
      },
      // falha de fetch = estado de erro dedicado (com retry), NUNCA o empty-state (que
      // significa "conta sem criativos" — enganaria o usuário).
      error: () => {
        this.loaded.set(true);
        this.failed.set(true);
      },
    });
  }

  protected onFile(e: Event): void {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    this.uploading.set(true);
    this.api.uploadCreative(this.accountId, file).subscribe({
      next: (out) => {
        this.uploading.set(false);
        input.value = ''; // reseta p/ re-selecionar o MESMO arquivo redisparar o change.
        toast.success(
          out.format === 'video'
            ? 'Vídeo enviado — estou processando; ele fica pronto pra usar em instantes.'
            : 'Imagem enviada — já dá pra reusar num rascunho.',
        );
        this.load();
      },
      error: () => {
        this.uploading.set(false);
        input.value = '';
        toast.error('Não consegui enviar esse arquivo. Verifique o formato e o tamanho e tente de novo.');
      },
    });
  }
}
