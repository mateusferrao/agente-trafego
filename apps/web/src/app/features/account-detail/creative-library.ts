import { ChangeDetectionStrategy, Component, type OnInit, inject, signal } from '@angular/core';
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
        <label class="cursor-pointer">
          <input type="file" accept="image/*" class="hidden" (change)="onFile($event)" [disabled]="uploading()" />
          <span appButton size="sm">{{ uploading() ? 'Enviando…' : 'Subir imagem' }}</span>
        </label>
      </div>

      @if (loaded() && assets().length === 0) {
        <app-ui-empty-state title="Nenhum criativo ainda" description="Suba uma imagem ou rode uma análise — os criativos dos seus anúncios entram aqui automaticamente." />
      } @else {
        <ul class="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          @for (a of assets(); track a.id) {
            <li class="flex flex-col gap-2 rounded-lg border border-line bg-panel p-3">
              <span class="flex items-center justify-between text-xs">
                <span class="font-medium text-ink">{{ a.origin === 'upload' ? 'Enviado' : 'Da conta' }}</span>
                <span class="text-muted">{{ a.format }} · {{ statusLabel(a.status) }}</span>
              </span>
              <span class="truncate font-mono text-[11px] text-muted" title="{{ a.metaImageHash ?? a.metaVideoId }}">
                {{ a.metaImageHash ?? a.metaVideoId ?? '—' }}
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

  protected readonly assets = signal<readonly CreativeAssetOutput[]>([]);
  protected readonly loaded = signal(false);
  protected readonly uploading = signal(false);

  protected statusLabel(s: CreativeAssetOutput['status']): string {
    return s === 'ready' ? 'pronto' : s === 'pending' ? 'processando' : 'erro';
  }

  ngOnInit(): void {
    this.load();
  }

  private load(): void {
    this.api.listCreatives(this.accountId).subscribe({
      next: (rows) => {
        this.assets.set(rows);
        this.loaded.set(true);
      },
      error: () => this.loaded.set(true),
    });
  }

  protected onFile(e: Event): void {
    const file = (e.target as HTMLInputElement).files?.[0];
    if (!file) return;
    this.uploading.set(true);
    const reader = new FileReader();
    reader.onload = () => {
      const base64 = String(reader.result).split(',')[1] ?? '';
      this.api
        .uploadCreative(this.accountId, { imageBase64: base64, contentType: file.type, filename: file.name })
        .subscribe({
          next: () => {
            toast.success('Imagem enviada — já dá pra reusar num rascunho.');
            this.uploading.set(false);
            this.load();
          },
          error: () => this.uploading.set(false),
        });
    };
    reader.onerror = () => this.uploading.set(false);
    reader.readAsDataURL(file);
  }
}
