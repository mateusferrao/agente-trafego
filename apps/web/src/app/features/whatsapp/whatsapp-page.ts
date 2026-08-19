import { ChangeDetectionStrategy, Component, DestroyRef, inject, signal } from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';
import { UiButton, UiPageHeader, UiSpinner } from '@ui';
import { ChannelApiService } from '@core/api/channel-api.service';
import type { ChannelStateOutput } from '@core/api/generated';

const POLL_INTERVAL_MS = 2500;
const DATA_URL_PREFIX = 'data:image/png;base64,';

/**
 * Onboarding do canal WhatsApp (3b): conectar o número por QR e verificar o
 * telefone do dono por código (opt-in — §9). Segue docs/DESIGN.md (status =
 * tom+texto, erro amigável + próximo passo, sem jargão).
 */
@Component({
  selector: 'app-whatsapp-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [UiButton, UiPageHeader, UiSpinner],
  template: `
    <div class="flex flex-col gap-8">
      <app-ui-page-header
        title="Conectar WhatsApp"
        subtitle="O agente usa o seu WhatsApp para te avisar quando encontrar algo importante."
      />

      @if (connectError()) {
        <p class="rounded-lg border border-line bg-panel p-4 text-sm text-danger-strong">{{ connectError() }}</p>
      }

      <!-- Passo 1: conectar a instância por QR -->
      <section class="flex flex-col gap-4 rounded-lg border border-line bg-panel p-5">
        <h2 class="font-brand text-sm font-semibold text-ink">1. Parear o número</h2>
        @if (connected()) {
          <p class="text-sm text-success-strong">WhatsApp conectado.</p>
        } @else if (qrCode()) {
          <p class="text-sm text-muted">
            Abra o WhatsApp no celular → Aparelhos conectados → Conectar aparelho, e aponte para o QR.
          </p>
          <img [src]="qrSrc()" alt="QR code para parear o WhatsApp" class="h-56 w-56 rounded-md border border-line bg-app" />
          <div class="flex items-center gap-2 text-xs text-muted">
            <app-ui-spinner [size]="16" [stroke]="2" aria-hidden="true" />
            Aguardando a leitura do QR…
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
          @if (verifyError()) {
            <p class="text-xs text-danger-strong">{{ verifyError() }}</p>
          }
        }
      </section>
    </div>
  `,
})
export class WhatsappPage {
  private readonly api = inject(ChannelApiService);
  private readonly destroyRef = inject(DestroyRef);
  private destroyed = false;

  protected readonly connecting = signal(false);
  protected readonly connected = signal(false);
  protected readonly qrCode = signal<string | null>(null);
  protected readonly connectError = signal<string | null>(null);

  protected readonly phone = signal('');
  protected readonly code = signal('');
  protected readonly sendingCode = signal(false);
  protected readonly codeSent = signal(false);
  protected readonly confirming = signal(false);
  protected readonly verified = signal(false);
  protected readonly verifyError = signal<string | null>(null);

  constructor() {
    this.destroyRef.onDestroy(() => {
      this.destroyed = true;
    });
    this.api.status().subscribe({
      next: (s) => this.applyState(s),
      error: () => {},
    });
  }

  protected qrSrc(): string {
    const qr = this.qrCode() ?? '';
    return qr.startsWith('data:') ? qr : `${DATA_URL_PREFIX}${qr}`;
  }

  protected connect(): void {
    this.connectError.set(null);
    this.connecting.set(true);
    this.api.connect().subscribe({
      next: (s) => {
        this.connecting.set(false);
        this.applyState(s);
        if (!this.connected()) this.poll();
      },
      error: (err: unknown) => {
        this.connecting.set(false);
        this.connectError.set(friendly(err, 'Não consegui gerar o QR agora. Tente de novo.'));
      },
    });
  }

  protected onPhone(event: Event): void {
    this.phone.set((event.target as HTMLInputElement).value.trim());
  }
  protected onCode(event: Event): void {
    this.code.set((event.target as HTMLInputElement).value.trim());
  }

  protected sendCode(): void {
    this.verifyError.set(null);
    this.sendingCode.set(true);
    this.api.startVerification({ phone: this.phone() }).subscribe({
      next: () => {
        this.sendingCode.set(false);
        this.codeSent.set(true);
      },
      error: (err: unknown) => {
        this.sendingCode.set(false);
        this.verifyError.set(friendly(err, 'Não consegui enviar o código agora.'));
      },
    });
  }

  protected confirm(): void {
    this.verifyError.set(null);
    this.confirming.set(true);
    this.api.confirmVerification({ phone: this.phone(), code: this.code() }).subscribe({
      next: (r) => {
        this.confirming.set(false);
        this.verified.set(r.verified);
        if (!r.verified) this.verifyError.set('Código inválido. Peça um novo e tente de novo.');
      },
      error: (err: unknown) => {
        this.confirming.set(false);
        this.verifyError.set(friendly(err, 'Código inválido ou expirado. Peça um novo código.'));
      },
    });
  }

  private applyState(s: ChannelStateOutput): void {
    this.connected.set(s.status === 'connected');
    this.qrCode.set(s.status === 'connecting' ? (s.qrCode ?? null) : null);
  }

  private poll(): void {
    if (this.destroyed || this.connected()) return;
    this.api.status().subscribe({
      next: (s) => {
        this.applyState(s);
        if (!this.connected()) setTimeout(() => this.poll(), POLL_INTERVAL_MS);
      },
      error: () => {},
    });
  }
}

function friendly(err: unknown, fallback: string): string {
  if (err instanceof HttpErrorResponse) {
    const message = (err.error as { message?: string } | null)?.message;
    if (message) return message;
  }
  return fallback;
}
