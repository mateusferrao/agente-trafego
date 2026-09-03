import { ChangeDetectionStrategy, Component, DestroyRef, type OnInit, computed, inject, signal } from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import { toast } from 'ngx-sonner';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucidePlay, lucideTrash2 } from '@ng-icons/lucide';
import { UiButton, UiEmptyState, UiConfirmDialogService } from '@ui';
import { AGENT_NAME } from '@core/brand';
import { DraftsApiService } from '@core/api/drafts-api.service';
import type { CreativeAssetOutput } from '@core/api/generated';

/**
 * Biblioteca de criativos da conta (Fatia 7): assets reusáveis nos rascunhos. Origem
 * `reuse` (dos anúncios da conta) ou `upload` (aqui). Roy usa o que está aqui pra montar
 * campanhas e nunca inventa mídia. Upload → sobe pra Meta (image_hash) → asset pronto.
 */
@Component({
  selector: 'app-creative-library',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [UiButton, UiEmptyState, NgIcon],
  providers: [provideIcons({ lucideTrash2, lucidePlay })],
  template: `
    <section class="flex flex-col gap-5 rounded-lg border border-line bg-panel p-5">
      <div class="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 class="font-brand text-base font-semibold text-ink">Criativos</h2>
          <p class="mt-1 text-xs text-muted">Mídias que você sobe pra usar nos rascunhos. Pra recomendar, {{ agentName }} também olha os criativos que já estão rodando na sua conta — nunca inventa mídia.</p>
        </div>
        @if (!isEmpty()) {
          <button type="button" appButton variant="primary" size="sm" [disabled]="uploading()" (click)="picker.click()">
            {{ uploading() ? 'Enviando…' : 'Subir criativo' }}
          </button>
        }
        <input #picker type="file" accept="image/*,video/*" class="hidden" (change)="onFile($event)" />
      </div>

      @if (failed()) {
        <div class="flex flex-col items-start gap-2 rounded-md border border-line bg-soft p-4 text-sm">
          <p class="text-ink">Não consegui carregar os criativos desta conta.</p>
          <button type="button" appButton variant="secondary" size="sm" (click)="load()">Tentar de novo</button>
        </div>
      } @else if (isEmpty()) {
        <app-ui-empty-state
          brand
          title="Sua estante de criativos está vazia"
          [description]="'Aqui você guarda mídias extras pra usar nos rascunhos. Pra recomendar uma campanha, ' + agentName + ' já escolhe sozinho o melhor criativo que está rodando na sua conta — subir aqui é opcional.'"
        >
          <button type="button" appButton variant="primary" actions [disabled]="uploading()" (click)="picker.click()">
            {{ uploading() ? 'Enviando…' : 'Subir criativo' }}
          </button>
        </app-ui-empty-state>
      } @else {
        <ul class="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          @for (a of assets(); track a.id) {
            <li class="flex flex-col gap-2 rounded-lg border border-line bg-panel p-3">
              <div class="relative flex aspect-square items-center justify-center overflow-hidden rounded-md bg-soft">
                @if (a.status === 'ready' && !broken().has(a.id)) {
                  <img
                    [src]="a.format === 'video' ? thumbUrl(a) : blobUrl(a)"
                    [alt]="a.origin === 'upload' ? 'Criativo enviado' : 'Criativo da conta'"
                    class="h-full w-full object-cover"
                    loading="lazy"
                    (error)="onImgError(a.id)"
                  />
                  @if (a.format === 'video') {
                    <!-- selo de play sobre a capa: comunica "é vídeo" por forma, não só cor (§13 UX). -->
                    <span class="pointer-events-none absolute inset-0 flex items-center justify-center" aria-hidden="true">
                      <span class="flex h-9 w-9 items-center justify-center rounded-full bg-ink/60">
                        <ng-icon name="lucidePlay" size="18" class="text-primary-ink" />
                      </span>
                    </span>
                  }
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
              <button
                type="button"
                appButton
                variant="ghost"
                size="sm"
                class="self-end"
                [disabled]="deletingId() === a.id"
                (click)="onDelete(a)"
              >
                <ng-icon name="lucideTrash2" size="14" aria-hidden="true" />
                {{ deletingId() === a.id ? 'Excluindo…' : 'Excluir' }}
              </button>
            </li>
          }
        </ul>
      }
    </section>
  `,
})
export class CreativeLibrary implements OnInit {
  private readonly api = inject(DraftsApiService);
  private readonly confirmDialog = inject(UiConfirmDialogService);
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

  protected readonly agentName = AGENT_NAME;
  protected readonly assets = signal<readonly CreativeAssetOutput[]>([]);
  protected readonly loaded = signal(false);
  protected readonly failed = signal(false);
  protected readonly uploading = signal(false);
  /** id do criativo em exclusão (desabilita o botão + rótulo "Excluindo…"). */
  protected readonly deletingId = signal<string | null>(null);
  /** ids cujo <img> falhou (blob 404 / ref drift) → cai no placeholder, nunca ícone quebrado. */
  protected readonly broken = signal<ReadonlySet<string>>(new Set());
  /** biblioteca carregada, sem falha e sem asset → mostra o empty-state de marca (com CTA). */
  protected readonly isEmpty = computed(() => this.loaded() && !this.failed() && this.assets().length === 0);

  /** URL da rota autenticada de blob — reusa o builder do service (evita drift). */
  protected blobUrl(a: CreativeAssetOutput): string {
    return this.api.creativeBlobUrl(this.accountId, a.id);
  }
  /** URL da miniatura (vídeo) — frame HD servido pela API; o `<img>` não renderiza o arquivo cru. */
  protected thumbUrl(a: CreativeAssetOutput): string {
    return this.api.creativeThumbUrl(this.accountId, a.id);
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
            ? 'Vídeo no forno. Deixo ele pronto pra usar em instantes.'
            : 'Imagem na estante. Já dá pra usar num rascunho.',
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

  /** Exclui um criativo (confirma antes). Híbrido no backend: em uso → ARQUIVA (some da
   *  estante, mantém a referência pra não quebrar campanha/rascunho); livre → apaga de vez.
   *  Some da lista dos dois jeitos; o toast diz qual aconteceu. */
  protected async onDelete(a: CreativeAssetOutput): Promise<void> {
    const confirmed = await this.confirmDialog.confirm({
      title: 'Excluir este criativo?',
      description: 'Ele sai da sua estante. Se estiver em uso numa campanha ou rascunho, eu arquivo em vez de apagar — nada quebra e ele deixa de ser usado nas próximas.',
      confirmLabel: 'Excluir',
      tone: 'danger',
    });
    if (!confirmed) return;
    this.deletingId.set(a.id);
    this.api.deleteCreative(this.accountId, a.id).subscribe({
      next: (res) => {
        this.assets.update((list) => list.filter((x) => x.id !== a.id));
        this.deletingId.set(null);
        toast.success(res.archived ? 'Criativo arquivado. Estava em uso, então não mexi nas campanhas.' : 'Criativo excluído.');
      },
      error: () => {
        this.deletingId.set(null);
        toast.error('Não consegui excluir esse criativo agora. Tente de novo em instantes.');
      },
    });
  }
}
