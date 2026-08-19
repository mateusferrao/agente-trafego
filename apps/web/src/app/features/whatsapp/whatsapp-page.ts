import { ChangeDetectionStrategy, Component, DestroyRef, inject, signal } from '@angular/core';
import { toast } from 'ngx-sonner';
import { UiButton, UiSpinner } from '@ui';
import { ChannelApiService } from '@core/api/channel-api.service';
import type { ChannelStateOutput } from '@core/api/generated';

const POLL_INTERVAL_MS = 2500;
/** Tenta reagendar o polling após erros transitórios de rede antes de desistir. */
const POLL_MAX_ERRORS = 5;
const DATA_URL_PREFIX = 'data:image/png;base64,';

/**
 * Onboarding do canal WhatsApp (3b): conectar o número por QR e verificar o
 * telefone do dono por código (opt-in — §9). Segue docs/DESIGN.md (status =
 * tom+texto, erro amigável + próximo passo, sem jargão).
 */
@Component({
  selector: 'app-whatsapp-connect',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [UiButton, UiSpinner],
  template: `
    <div class="flex flex-col gap-4">
      <!-- Passo 1: conectar a instância por QR -->
      <section class="flex flex-col gap-4 rounded-lg border border-line bg-panel p-5">
        <h2 class="font-brand text-sm font-semibold text-ink">1. Parear o número</h2>
        @if (loading()) {
          <div class="flex items-center gap-2 text-xs text-muted">
            <app-ui-spinner [size]="16" [stroke]="2" aria-hidden="true" />
            Verificando a conexão…
          </div>
        } @else if (connected()) {
          <p class="text-sm text-success-strong">WhatsApp conectado.</p>
        } @else if (qrCode()) {
          <p class="text-sm text-muted">
            Abra o WhatsApp no celular → Aparelhos conectados → Conectar aparelho, e aponte para o QR.
          </p>
          <img [src]="qrSrc()" alt="QR code para parear o WhatsApp" class="h-56 w-56 rounded-md border border-line bg-app" />
          <div class="flex flex-wrap items-center gap-3 text-xs text-muted">
            <span class="flex items-center gap-2">
              <app-ui-spinner [size]="16" [stroke]="2" aria-hidden="true" />
              {{ pollStalled() ? 'Conexão instável — tentando de novo…' : 'Aguardando a leitura do QR…' }}
            </span>
            <!-- QR da Evolution expira em ~1 min; permite gerar um novo sem sair. -->
            <button appButton variant="ghost" size="sm" type="button" [disabled]="connecting()" (click)="connect()">
              {{ connecting() ? 'Gerando…' : 'Gerar novo QR' }}
            </button>
          </div>
        } @else {
          <p class="text-sm text-muted">Gere o QR para parear o número da sua organização.</p>
          <button appButton variant="primary" type="button" [disabled]="connecting()" (click)="connect()">
            {{ connecting() ? 'Gerando…' : 'Conectar WhatsApp' }}
          </button>
        }
      </section>

      <!-- Passo 2: verificar o telefone do dono por código -->
      <section class="flex flex-col gap-4 rounded-lg border border-line bg-panel p-5" [class.opacity-50]="!connected()">
        <h2 class="font-brand text-sm font-semibold text-ink">2. Confirmar o seu número</h2>
        @if (verified()) {
          <p class="text-sm text-success-strong">Número confirmado. Você vai receber as análises por aqui.</p>
        } @else {
          <p class="text-xs text-muted">
            Enviamos um código para o seu WhatsApp; digite-o abaixo para confirmar que o número é seu.
          </p>
          <div class="flex flex-wrap items-end gap-3">
            <label class="flex flex-col gap-1 text-xs text-muted">
              Seu WhatsApp (com DDD)
              <input
                type="tel"
                placeholder="+5511999999999"
                class="w-52 rounded-md border border-line bg-app px-3 py-2 text-sm text-ink"
                [value]="phone()"
                (input)="onPhone($event)"
              />
            </label>
            <button appButton variant="secondary" type="button" [disabled]="!connected() || sendingCode()" (click)="sendCode()">
              {{ sendingCode() ? 'Enviando…' : 'Enviar código' }}
            </button>
          </div>
          @if (codeSent()) {
            <div class="flex flex-wrap items-end gap-3">
              <label class="flex flex-col gap-1 text-xs text-muted">
                Código (6 dígitos)
                <input
                  inputmode="numeric"
                  maxlength="6"
                  class="w-32 rounded-md border border-line bg-app px-3 py-2 text-sm tracking-widest text-ink"
                  [value]="code()"
                  (input)="onCode($event)"
                />
              </label>
              <button appButton variant="primary" type="button" [disabled]="confirming()" (click)="confirm()">
                {{ confirming() ? 'Confirmando…' : 'Confirmar' }}
              </button>
            </div>
          }
        }
      </section>
    </div>
  `,
})
export class WhatsappConnect {
  private readonly api = inject(ChannelApiService);
  private readonly destroyRef = inject(DestroyRef);
  private destroyed = false;
  /** o usuário já disparou connect() → ignora o status inicial (evita corrida). */
  private connectStarted = false;
  /** erros de polling consecutivos (reagenda até o teto antes de parar). */
  private pollErrors = 0;

  protected readonly loading = signal(true);
  protected readonly connecting = signal(false);
  protected readonly connected = signal(false);
  protected readonly qrCode = signal<string | null>(null);
  protected readonly pollStalled = signal(false);

  protected readonly phone = signal('');
  protected readonly code = signal('');
  protected readonly sendingCode = signal(false);
  protected readonly codeSent = signal(false);
  protected readonly confirming = signal(false);
  protected readonly verified = signal(false);

  constructor() {
    this.destroyRef.onDestroy(() => {
      this.destroyed = true;
    });
    this.api.status(true).subscribe({
      next: (s) => {
        if (!this.connectStarted) this.applyState(s); // não sobrescreve um QR recém-obtido
        this.loading.set(false);
      },
      error: () => this.loading.set(false),
    });
  }

  protected qrSrc(): string {
    const qr = this.qrCode() ?? '';
    return qr.startsWith('data:') ? qr : `${DATA_URL_PREFIX}${qr}`;
  }

  protected connect(): void {
    this.connectStarted = true;
    this.loading.set(false);
    this.connecting.set(true);
    this.api.connect().subscribe({
      next: (s) => {
        this.connecting.set(false);
        this.applyState(s);
        if (!this.connected()) this.poll();
      },
      // erro amigável já vem do interceptor global (api-request.interceptor).
      error: () => this.connecting.set(false),
    });
  }

  protected onPhone(event: Event): void {
    this.phone.set((event.target as HTMLInputElement).value.trim());
  }
  protected onCode(event: Event): void {
    this.code.set((event.target as HTMLInputElement).value.trim());
  }

  protected sendCode(): void {
    this.sendingCode.set(true);
    this.api.startVerification({ phone: this.phone() }).subscribe({
      next: () => {
        this.sendingCode.set(false);
        this.codeSent.set(true);
        toast.success('Código enviado para o seu WhatsApp');
      },
      // erro amigável já vem do interceptor global.
      error: () => this.sendingCode.set(false),
    });
  }

  protected confirm(): void {
    this.confirming.set(true);
    this.api.confirmVerification({ phone: this.phone(), code: this.code() }).subscribe({
      next: (r) => {
        this.confirming.set(false);
        this.verified.set(r.verified);
        // resposta 200 com código errado não é erro HTTP → toast explícito.
        if (r.verified) toast.success('Número confirmado');
        else toast.error('Código inválido. Peça um novo e tente de novo.');
      },
      // erro amigável já vem do interceptor global.
      error: () => this.confirming.set(false),
    });
  }

  private applyState(s: ChannelStateOutput): void {
    const isConnected = s.status === 'connected';
    this.connected.set(isConnected);
    // O QR só vem no `connect` — o polling (connectionState) NÃO o devolve. Então:
    // conectou → limpa; veio QR novo → atualiza; senão MANTÉM o atual (não apagar
    // num poll sem QR, senão o QR "some" e a tela volta pro botão — bug).
    if (isConnected) this.qrCode.set(null);
    else if (s.qrCode) this.qrCode.set(s.qrCode);
  }

  private poll(): void {
    if (this.destroyed || this.connected()) return;
    // silent: o polling não pode spammar toast a cada blip — reage pela UI
    // (estado "instável") e emite um toast único ao esgotar as tentativas.
    this.api.status(true).subscribe({
      next: (s) => {
        this.pollErrors = 0;
        this.pollStalled.set(false);
        this.applyState(s);
        if (this.connected()) toast.success('WhatsApp conectado');
        else setTimeout(() => this.poll(), POLL_INTERVAL_MS);
      },
      error: () => {
        // blip transitório (rede/5xx) não pode matar o polling em silêncio: reagenda
        // até o teto, sinalizando "instável"; só então para (o usuário pode reconectar).
        this.pollErrors += 1;
        if (this.pollErrors <= POLL_MAX_ERRORS) {
          this.pollStalled.set(true);
          setTimeout(() => this.poll(), POLL_INTERVAL_MS);
        } else {
          this.pollStalled.set(false);
          toast.error('Perdi a conexão ao verificar o pareamento. Gere o QR de novo.');
        }
      },
    });
  }
}
