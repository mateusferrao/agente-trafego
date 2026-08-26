import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideRefreshCw, lucidePlus, lucideX, lucidePlug } from '@ng-icons/lucide';
import {
  UiButton,
  UiDialog,
  UiDialogOverlay,
  UiDialogTitle,
  UiEmptyState,
  UiEyebrow,
  UiPageHeader,
  UiSpinner,
} from '@ui';
import { toast } from 'ngx-sonner';
import { AGENT_NAME } from '@core/brand';
import { ConnectionsApiService } from '@core/api/connections-api.service';
import { ChannelApiService } from '@core/api/channel-api.service';
import type { ConnectionAccountsOutput, ConnectionOutput } from '@core/api/generated';
import { ConnectDialogComponent, type ConnectDialogDoneEvent } from './components/connect-dialog';
import { PROVIDER_CATALOG } from './catalog/provider-catalog';
import type { ProviderCatalogEntry } from './domain/provider-catalog-entry';
import { WhatsappConnect } from '../whatsapp/whatsapp-page';

type TokenStatus = ConnectionOutput['tokenStatus'];
type ChannelStatus = 'connected' | 'connecting' | 'disconnected';
type BadgeTone = 'success' | 'info' | 'warning' | 'danger' | 'neutral';
/** Tom → classe de texto (status como eyebrow colorido — tom+texto, sem pill). */
const TONE_TEXT: Record<BadgeTone, string> = {
  success: 'text-success-strong',
  info: 'text-info-strong',
  warning: 'text-warning-strong',
  danger: 'text-danger-strong',
  neutral: 'text-muted',
};
type ConnectionAccount = ConnectionAccountsOutput['available'][number];
type ManagedAccountRef = ConnectionAccountsOutput['managed'][number];

const TOKEN_TONE: Record<TokenStatus, BadgeTone> = {
  valid: 'success',
  invalid: 'danger',
  unchecked: 'neutral',
};
const TOKEN_TEXT: Record<TokenStatus, string> = {
  valid: 'Acesso válido',
  invalid: 'Acesso expirado — reconecte',
  unchecked: 'Acesso não verificado',
};
const CHANNEL_TONE: Record<ChannelStatus, BadgeTone> = {
  connected: 'success',
  connecting: 'warning',
  disconnected: 'neutral',
};
const CHANNEL_TEXT: Record<ChannelStatus, string> = {
  connected: 'Ativa',
  connecting: 'Conectando',
  disconnected: 'Desconectada',
};

/**
 * Integrações (aba agnóstica): conecta sistemas externos por **cards de provedor**
 * (grid "Disponíveis") que abrem o connect-dialog (Meta) ou o fluxo de QR (WhatsApp).
 * "Conectadas" lista o que já está ligado. Não conecta nada direto do header — cada
 * provedor conecta pelo seu card. Segue docs/DESIGN.md (status = tom+texto).
 */
@Component({
  selector: 'app-integrations-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    NgIcon,
    UiButton,
    UiDialog,
    UiDialogOverlay,
    UiDialogTitle,
    UiEmptyState,
    UiEyebrow,
    UiPageHeader,
    UiSpinner,
    ConnectDialogComponent,
    WhatsappConnect,
  ],
  providers: [provideIcons({ lucideRefreshCw, lucidePlus, lucideX, lucidePlug })],
  template: `
    <div class="flex flex-col gap-8">
      <app-ui-page-header
        title="Integrações"
        subtitle="Conecte a Meta e o WhatsApp e escolha quais contas o agente vai gerir."
      />

      <!-- Conectadas -->
      <section class="flex flex-col gap-3">
        <div class="flex items-center gap-2">
          <h2 class="font-brand text-sm font-semibold text-ink">Conectadas</h2>
          @if (!loading()) {
            <span class="rounded-full bg-soft px-2 py-0.5 text-xs text-muted">{{ connectedCount() }}</span>
          }
        </div>

        @if (loading()) {
          <div class="flex items-center justify-center gap-3 rounded-lg border border-line bg-panel p-10 text-sm text-muted">
            <app-ui-spinner [size]="20" [stroke]="2" aria-hidden="true" />
            Carregando…
          </div>
        } @else if (connectedCount() === 0) {
          <app-ui-empty-state
            icon="lucidePlug"
            title="Nada conectado ainda"
            description="Escolha um provedor abaixo para conectar a Meta e o WhatsApp."
          />
        } @else {
          <div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <!-- Canal WhatsApp -->
            @if (channelConnected()) {
              <div class="flex flex-col gap-3 rounded-lg border border-line bg-panel p-5">
                <div class="flex items-start justify-between gap-3">
                  <span class="grid size-10 place-items-center rounded-lg bg-soft">
                    <img src="/integrations/whatsapp.svg" alt="" class="size-6" />
                  </span>
                  <app-ui-eyebrow [class]="toneText(channelTone())">{{ channelText() }}</app-ui-eyebrow>
                </div>
                <div class="flex flex-col gap-0.5">
                  <h3 class="font-brand text-base font-semibold text-ink">WhatsApp</h3>
                  <p class="text-xs text-muted">Canal de mensagem da organização</p>
                </div>
                <div class="flex items-center gap-2 border-t border-line pt-3">
                  <button appButton variant="secondary" type="button" (click)="openWhatsapp()">Gerenciar</button>
                </div>
              </div>
            }

            <!-- Conexões Meta -->
            @for (conn of connections(); track conn.id) {
              <div class="flex flex-col gap-3 rounded-lg border border-line bg-panel p-5">
                <div class="flex items-start justify-between gap-3">
                  <span class="grid size-10 place-items-center rounded-lg bg-soft">
                    <img src="/integrations/meta-ads.svg" alt="" class="size-6" />
                  </span>
                  <app-ui-eyebrow [class]="toneText(tokenTone(conn.tokenStatus))">
                    {{ tokenText(conn.tokenStatus) }}
                  </app-ui-eyebrow>
                </div>
                <div class="flex flex-col gap-0.5">
                  <h3 class="font-brand text-base font-semibold text-ink">Meta Ads</h3>
                  <p class="text-xs text-muted">
                    {{ conn.accountsCount }} {{ conn.accountsCount === 1 ? 'conta ativa' : 'contas ativas' }}
                    @if (conn.externalBusinessId) { · negócio {{ conn.externalBusinessId }} }
                  </p>
                </div>
                <div class="flex items-center gap-2 border-t border-line pt-3">
                  <button appButton variant="secondary" type="button" (click)="openManage(conn)">
                    Gerenciar contas
                  </button>
                  <button
                    appButton
                    variant="ghost"
                    size="sm"
                    type="button"
                    [disabled]="syncingId() === conn.id"
                    (click)="syncConnection(conn)"
                    aria-label="Sincronizar contas"
                    title="Sincronizar contas"
                  >
                    <ng-icon name="lucideRefreshCw" size="16" aria-hidden="true" />
                  </button>
                </div>
              </div>
            }
          </div>
        }
      </section>

      <!-- Disponíveis para conectar -->
      <section class="flex flex-col gap-3">
        <h2 class="font-brand text-sm font-semibold text-ink">Disponíveis para conectar</h2>
        <div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          @for (entry of availableProviders(); track entry.id) {
            <button
              type="button"
              (click)="openProvider(entry)"
              class="flex flex-col gap-2 rounded-lg border border-line bg-panel p-5 text-left transition-colors hover:bg-soft"
            >
              <div class="flex items-start justify-between gap-3">
                <!-- não conectado → logo mono (preto e branco); colorido só quando conectado. -->
                <span class="grid size-10 place-items-center rounded-lg bg-soft">
                  <img [src]="'/integrations/' + entry.icon + '-mono.svg'" alt="" class="size-6" />
                </span>
                <app-ui-eyebrow>Disponível</app-ui-eyebrow>
              </div>
              <span class="text-xs font-semibold uppercase tracking-wide text-muted">{{ entry.category }}</span>
              <h3 class="font-brand text-base font-semibold text-ink">{{ entry.name }}</h3>
              <p class="text-sm text-muted">{{ entry.description }}</p>
              <span class="mt-1 inline-flex items-center gap-1 text-sm font-medium text-accent-strong">
                <ng-icon name="lucidePlus" size="15" aria-hidden="true" /> Conectar
              </span>
            </button>
          }
        </div>
      </section>
    </div>

    <!-- Connect-dialog do provedor selecionado (Meta) -->
    @if (dialogEntry(); as entry) {
      <app-connect-dialog [entry]="entry" (done)="onDialogDone($event)" (closed)="closeDialog()" />
    }

    <!-- Fluxo de QR do WhatsApp (dialog próprio — Evolution, não credencial) -->
    @if (whatsappOpen()) {
      <div appDialogOverlay>
        <section appDialog aria-labelledby="wa-dialog-title" [ngpDialogModal]="true">
          <div class="flex items-start justify-between gap-3">
            <h2 appDialogTitle id="wa-dialog-title">Conectar WhatsApp</h2>
            <button appButton variant="ghost" size="sm" type="button" (click)="closeWhatsapp()" aria-label="Fechar">
              <ng-icon name="lucideX" size="17" aria-hidden="true" />
            </button>
          </div>
          <div class="mt-4">
            <app-whatsapp-connect />
          </div>
        </section>
      </div>
    }

    <!-- Gerenciar contas de uma conexão (multi-seleção) -->
    @if (manageOpen()) {
      <div appDialogOverlay>
        <section appDialog aria-labelledby="manage-dialog-title" [ngpDialogModal]="true">
          <h2 appDialogTitle id="manage-dialog-title">Gerenciar contas</h2>
          @if (manageLoading()) {
            <div class="mt-4 flex items-center justify-center gap-3 py-8 text-sm text-muted">
              <app-ui-spinner [size]="20" [stroke]="2" aria-hidden="true" />
              Carregando contas…
            </div>
          } @else if (available().length === 0) {
            <p class="mt-3 text-sm text-muted">Nenhuma conta de anúncio acessível por essa conexão.</p>
          } @else {
            <p class="mt-2 text-sm text-muted">Marque as contas que o agente vai gerir.</p>
            <div class="mt-3 flex max-h-72 flex-col gap-2 overflow-y-auto">
              @for (acc of available(); track acc.id) {
                <label
                  class="flex cursor-pointer items-center justify-between gap-3 rounded-md border px-4 py-3"
                  [class.border-accent]="isSelected(acc.id)"
                  [class.bg-accent-soft]="isSelected(acc.id)"
                  [class.border-line]="!isSelected(acc.id)"
                >
                  <span class="flex min-w-0 flex-col">
                    <span class="truncate text-sm font-semibold text-ink">{{ acc.name }}</span>
                    <span class="text-xs text-muted">{{ acc.id }}{{ acc.currency ? ' · ' + acc.currency : '' }}</span>
                  </span>
                  <input type="checkbox" class="size-4 shrink-0" [checked]="isSelected(acc.id)" (change)="toggle(acc.id)" />
                </label>
              }
            </div>
          }
          <footer class="mt-5 flex items-center justify-end gap-2">
            <button appButton variant="ghost" type="button" (click)="closeManage()">Cancelar</button>
            <button appButton variant="primary" type="button" [disabled]="saving() || manageLoading()" (click)="saveSelection()">
              {{ saving() ? 'Salvando…' : 'Salvar seleção' }}
            </button>
          </footer>
        </section>
      </div>
    }
  `,
})
export class IntegrationsPage {
  private readonly api = inject(ConnectionsApiService);
  private readonly channelApi = inject(ChannelApiService);

  protected readonly connections = signal<ConnectionOutput[]>([]);
  protected readonly loading = signal(true);
  protected readonly channelStatus = signal<ChannelStatus>('disconnected');
  protected readonly syncingId = signal<string | null>(null);

  protected readonly dialogEntry = signal<ProviderCatalogEntry | null>(null);
  protected readonly whatsappOpen = signal(false);

  // "Gerenciar contas" (multi-seleção).
  protected readonly manageOpen = signal(false);
  protected readonly manageLoading = signal(false);
  protected readonly available = signal<ConnectionAccount[]>([]);
  protected readonly selected = signal<ReadonlySet<string>>(new Set());
  protected readonly saving = signal(false);
  private activeConnectionId: string | null = null;

  protected readonly channelConnected = computed(() => this.channelStatus() !== 'disconnected');
  protected readonly connectedCount = computed(
    () => this.connections().length + (this.channelConnected() ? 1 : 0),
  );
  /** Grid "Disponíveis": Meta sempre (pode-se adicionar outra conexão); WhatsApp só se ainda não conectado. */
  protected readonly availableProviders = computed<ProviderCatalogEntry[]>(() =>
    PROVIDER_CATALOG.filter((p) => p.connectFlow !== 'whatsapp-qr' || !this.channelConnected()),
  );

  constructor() {
    this.reload();
  }

  protected tokenTone(status: TokenStatus): BadgeTone {
    return TOKEN_TONE[status];
  }
  protected toneText(tone: BadgeTone): string {
    return TONE_TEXT[tone];
  }
  protected tokenText(status: TokenStatus): string {
    return TOKEN_TEXT[status];
  }
  protected channelTone(): BadgeTone {
    return CHANNEL_TONE[this.channelStatus()];
  }
  protected channelText(): string {
    return CHANNEL_TEXT[this.channelStatus()];
  }
  protected isSelected(id: string): boolean {
    return this.selected().has(id);
  }

  protected openProvider(entry: ProviderCatalogEntry): void {
    if (entry.connectFlow === 'whatsapp-qr') this.openWhatsapp();
    else this.dialogEntry.set(entry);
  }

  protected openWhatsapp(): void {
    this.whatsappOpen.set(true);
  }

  protected onDialogDone(event: ConnectDialogDoneEvent): void {
    if (event.result.kind === 'success') {
      this.reload();
      toast.success(`Conta conectada. O ${AGENT_NAME} já começou a analisar.`);
    }
  }
  protected closeDialog(): void {
    this.dialogEntry.set(null);
  }
  protected closeWhatsapp(): void {
    this.whatsappOpen.set(false);
    this.refreshChannel();
  }

  protected openManage(conn: ConnectionOutput): void {
    this.activeConnectionId = conn.id;
    this.available.set([]);
    this.selected.set(new Set());
    this.manageLoading.set(true);
    this.manageOpen.set(true);
    this.api.accounts(conn.id).subscribe({
      next: (res) => {
        this.available.set(res.available);
        this.selected.set(activeManagedIds(res.managed));
        this.manageLoading.set(false);
      },
      error: () => this.closeManage(),
    });
  }

  protected toggle(id: string): void {
    this.selected.update((set) => {
      const next = new Set(set);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  protected saveSelection(): void {
    const connectionId = this.activeConnectionId;
    if (!connectionId) return;
    this.saving.set(true);
    this.api.select(connectionId, { adAccountIds: [...this.selected()] }).subscribe({
      next: () => {
        this.saving.set(false);
        toast.success('Contas atualizadas');
        this.closeManage();
        this.reload();
      },
      error: () => this.saving.set(false),
    });
  }

  protected closeManage(): void {
    this.manageOpen.set(false);
  }

  protected syncConnection(conn: ConnectionOutput): void {
    this.syncingId.set(conn.id);
    this.api.sync(conn.id).subscribe({
      next: (res) => {
        this.syncingId.set(null);
        toast.success(syncSummary(res.changes));
        this.reload();
      },
      error: () => this.syncingId.set(null),
    });
  }

  private reload(): void {
    this.api.list().subscribe({
      next: (rows) => {
        this.connections.set(rows);
        this.loading.set(false);
      },
      error: () => this.loading.set(false),
    });
    this.refreshChannel();
  }

  private refreshChannel(): void {
    // silencioso: ausência de canal não é erro a toastar (a UI mostra "disponível").
    this.channelApi.status(true).subscribe({
      next: (s) => this.channelStatus.set(s.status),
      error: () => this.channelStatus.set('disconnected'),
    });
  }
}

/** ids das contas geridas que estão ativas (pré-seleção do "gerenciar contas"). */
function activeManagedIds(managed: readonly ManagedAccountRef[]): ReadonlySet<string> {
  return new Set(managed.filter((m) => m.status === 'active').map((m) => m.adAccountId));
}

/** Resumo humano do que a sincronização mudou (toast). */
function syncSummary(changes: {
  reactivated: number;
  markedUnavailable: number;
  newAvailable: number;
}): string {
  const parts: string[] = [];
  if (changes.newAvailable > 0) parts.push(`${changes.newAvailable} nova(s) disponível(is)`);
  if (changes.reactivated > 0) parts.push(`${changes.reactivated} reativada(s)`);
  if (changes.markedUnavailable > 0) parts.push(`${changes.markedUnavailable} indisponível(is)`);
  return parts.length > 0 ? `Sincronizado — ${parts.join(', ')}` : 'Sincronizado — nada mudou';
}
