import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { toast } from 'ngx-sonner';
import { UiButton, UiSpinner } from '@ui';
import { ChannelApiService } from '@core/api/channel-api.service';
import type { ChannelStateOutput, GroupsListOutput } from '@core/api/generated';

type GroupOption = GroupsListOutput['groups'][number];

const POLL_INTERVAL_MS = 2500;
/** Tenta reagendar o polling após erros transitórios de rede antes de desistir. */
const POLL_MAX_ERRORS = 5;
const DATA_URL_PREFIX = 'data:image/png;base64,';
/** E.164: '+' + DDI (1-9) + 6..14 dígitos. Mesmo contrato do backend (contacts). */
const E164_RE = /^\+[1-9]\d{6,14}$/;
const CODE_RE = /^\d{6}$/;

/**
 * Normaliza o telefone digitado para E.164: mantém só dígitos e '+', garante um
 * único '+' na frente (se o usuário digitou só números, prefixa). Aceita máscara
 * (+55 11 99999-9999) e cola — some com o erro de "payload" por formato.
 */
function normalizePhone(raw: string): string {
  const cleaned = raw.replace(/[^\d+]/g, '').replace(/\++/g, '+').replace(/(.)\+/g, '$1');
  if (cleaned === '' || cleaned === '+') return cleaned;
  return cleaned.startsWith('+') ? cleaned : `+${cleaned}`;
}

/** Só os dígitos — p/ comparar destinatário × número pareado sem depender do formato. */
function onlyDigits(value: string): string {
  return value.replace(/\D/g, '');
}

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
        <div class="flex flex-col gap-1">
          <h2 class="font-brand text-sm font-semibold text-ink">1. Parear o número do agente</h2>
          <p class="text-xs text-muted">
            É o WhatsApp de onde o agente vai <strong>enviar</strong> as análises. Pareie o número da
            sua organização escaneando o QR.
          </p>
        </div>
        @if (loading()) {
          <div class="flex items-center gap-2 text-xs text-muted">
            <app-ui-spinner [size]="16" [stroke]="2" aria-hidden="true" />
            Verificando a conexão…
          </div>
        } @else if (connected()) {
          <p class="text-sm text-success-strong">
            WhatsApp conectado — o agente fala pelo {{ pairedPhone() ?? 'número pareado' }}.
          </p>
          @if (confirmDisconnect()) {
            <div class="flex flex-col gap-2 rounded-md bg-soft p-3">
              <p class="text-xs text-muted">
                Desconectar remove o pareamento — o agente para de te avisar até você parear de novo.
              </p>
              <div class="flex items-center gap-2">
                <button appButton variant="secondary" type="button" [disabled]="disconnecting()" (click)="disconnect()">
                  {{ disconnecting() ? 'Desconectando…' : 'Desconectar' }}
                </button>
                <button appButton variant="ghost" type="button" [disabled]="disconnecting()" (click)="confirmDisconnect.set(false)">
                  Cancelar
                </button>
              </div>
            </div>
          } @else {
            <button appButton variant="ghost" size="sm" type="button" (click)="confirmDisconnect.set(true)">
              Desconectar
            </button>
          }
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

      <!-- Passo 2: verificar o número que vai RECEBER as análises -->
      <section class="flex flex-col gap-4 rounded-lg border border-line bg-panel p-5" [class.opacity-50]="!connected()">
        <div class="flex flex-col gap-1">
          <h2 class="font-brand text-sm font-semibold text-ink">2. Confirmar para onde receber</h2>
          <p class="text-xs text-muted">
            Informe o seu WhatsApp pessoal — é para onde o agente vai te enviar as análises. Ele manda
            um código do número pareado acima para confirmar. Use um número <strong>diferente</strong>
            do número do agente (ele não envia mensagem para si mesmo).
          </p>
        </div>
        @if (verified()) {
          <div class="flex flex-wrap items-center justify-between gap-2">
            <p class="text-sm text-success-strong">
              Número confirmado: {{ phone() }}. Você recebe as análises por aqui.
            </p>
            <button appButton variant="ghost" size="sm" type="button" [disabled]="changingRecipient()" (click)="trocarNumero()">
              {{ changingRecipient() ? 'Removendo…' : 'Trocar número' }}
            </button>
          </div>
        } @else {
          <div class="flex flex-wrap items-end gap-3">
            <label class="flex flex-col gap-1 text-xs text-muted">
              Seu WhatsApp (com DDI + DDD)
              <input
                type="tel"
                placeholder="+55 11 99999-9999"
                class="w-56 rounded-md border border-line bg-app px-3 py-2 text-sm text-ink"
                [value]="phone()"
                (input)="onPhone($event)"
              />
            </label>
            <button
              appButton
              variant="secondary"
              type="button"
              [disabled]="!connected() || !phoneValid() || recipientIsPaired() || sendingCode()"
              (click)="sendCode()"
            >
              {{ sendingCode() ? 'Enviando…' : codeSent() ? 'Reenviar código' : 'Enviar código' }}
            </button>
          </div>
          @if (phone() && !phoneValid()) {
            <p class="text-xs text-warning-strong">
              Use o formato internacional com DDI: + código do país + DDD + número (ex: +55 11 99999-9999).
            </p>
          } @else if (recipientIsPaired()) {
            <p class="text-xs text-warning-strong">
              Esse é o mesmo número do agente. O WhatsApp não entrega mensagem que você envia pra si
              mesmo — use o seu número pessoal para receber as análises.
            </p>
          }
          @if (codeSent()) {
            @if (codeExpired()) {
              <p class="text-xs text-warning-strong">
                O código expirou. Clique em "Reenviar código" para receber um novo.
              </p>
            } @else {
              <p class="text-xs text-muted">
                Código enviado para {{ sentPhone() }} — válido por {{ remainingLabel() }}. Digite-o abaixo.
              </p>
            }
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
              <button
                appButton
                variant="primary"
                type="button"
                [disabled]="!codeValid() || confirming() || codeExpired()"
                (click)="confirm()"
              >
                {{ confirming() ? 'Confirmando…' : 'Confirmar' }}
              </button>
            </div>
          }
        }
      </section>

      <!-- Passo 3: grupo do WhatsApp (opcional) — espelho do número: 1 grupo por org,
           o agente atua nele igual à DM (leitura, escrita, aprovação, config). -->
      <section class="flex flex-col gap-4 rounded-lg border border-line bg-panel p-5" [class.opacity-50]="!connected()">
        <div class="flex flex-col gap-1">
          <h2 class="font-brand text-sm font-semibold text-ink">3. Grupo do WhatsApp (opcional)</h2>
          <p class="text-xs text-muted">
            Além de te avisar no seu WhatsApp, o agente pode atuar dentro de um grupo — alertas e
            análises ficam visíveis pro time, e qualquer pessoa no grupo pode perguntar ao agente.
          </p>
        </div>

        @if (activeGroupName(); as name) {
          <div class="flex flex-wrap items-center justify-between gap-2">
            <p class="text-sm text-success-strong">Grupo ativo: {{ name }}</p>
            <button appButton variant="ghost" size="sm" type="button" [disabled]="disablingGroup()" (click)="disableGroup()">
              {{ disablingGroup() ? 'Desligando…' : 'Desligar' }}
            </button>
          </div>
          <p class="text-xs text-muted">
            Avisos proativos (alerta/resumo) vão pro grupo em vez do seu WhatsApp pessoal.
          </p>
        } @else {
          <div class="flex flex-col gap-2 rounded-md bg-soft p-3 text-xs text-muted">
            <p>Qualquer pessoa no grupo poderá pedir análise, aprovar ações e mudar a config do agente.</p>
            <p>Recomendado pro time interno ou org de 1 cliente — com vários clientes, evite colocar gente de fora ainda.</p>
          </div>

          @if (groupsLoading() && !groupsFetched()) {
            <p class="flex items-center gap-2 text-xs text-muted">
              <app-ui-spinner [size]="14" [stroke]="2" aria-hidden="true" />
              Buscando grupos…
            </p>
          } @else if (groupsLoadFailed()) {
            <p class="text-sm text-warning-strong">
              Não consegui buscar os grupos agora. Tenta de novo?
            </p>
            <button appButton variant="ghost" size="sm" type="button" [disabled]="!connected() || groupsLoading()" (click)="loadGroups()">
              {{ groupsLoading() ? 'Tentando…' : 'Tentar de novo' }}
            </button>
          } @else if (groups().length === 0) {
            <p class="text-sm text-muted">
              Nenhum grupo encontrado — adicione o número do agente a um grupo no WhatsApp e clique em atualizar.
            </p>
            <button appButton variant="ghost" size="sm" type="button" [disabled]="!connected() || groupsLoading()" (click)="loadGroups()">
              {{ groupsLoading() ? 'Atualizando…' : 'Atualizar' }}
            </button>
          } @else {
            @if (groups().length > 5) {
              <input
                type="text"
                placeholder="Buscar grupo…"
                aria-label="Buscar grupo"
                class="w-full rounded-md border border-line bg-app px-3 py-2 text-sm text-ink"
                [value]="groupFilter()"
                (input)="onGroupFilter($event)"
              />
            }
            @if (filteredGroups().length === 0) {
              <p class="text-sm text-muted">Nenhum grupo encontrado para "{{ groupFilter() }}".</p>
            }
            <!-- Sem max-height/scroll próprio aqui de propósito: o dialog (appDialog,
                 ui-dialog.ts) já é o único scroll container (max-h-[90vh] overflow-y-auto).
                 Scroll aninhado (lista rolando dentro do dialog que também rola) trava em
                 touch/mobile quando o gesto chega ao fim da lista interna e não "vaza" pro
                 scroll externo — com muitos grupos, o resto do conteúdo (fim da lista, botão
                 "Atualizar lista") ficava inacessível. Fluir na única rolagem resolve. -->
            <ul class="flex flex-col gap-1">
              @for (g of filteredGroups(); track g.jid) {
                <li class="flex items-center justify-between gap-2 rounded-md px-2 py-1.5 hover:bg-soft">
                  <span class="truncate text-sm text-ink">{{ g.name ?? g.jid }}</span>
                  <button
                    appButton
                    variant="secondary"
                    size="sm"
                    type="button"
                    [disabled]="!connected() || settingGroupJid() !== null"
                    (click)="activateGroup(g)"
                  >
                    {{ settingGroupJid() === g.jid ? 'Ativando…' : 'Ativar' }}
                  </button>
                </li>
              }
            </ul>
            <button appButton variant="ghost" size="sm" type="button" [disabled]="!connected() || groupsLoading()" (click)="loadGroups()">
              {{ groupsLoading() ? 'Atualizando…' : 'Atualizar lista' }}
            </button>
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
  /** Número pareado no QR (dono da instância), quando a Evolution informa. */
  protected readonly pairedPhone = signal<string | null>(null);

  protected readonly phone = signal('');
  /** Número para o qual o código foi de fato enviado (imune a edições no input). */
  protected readonly sentPhone = signal('');
  protected readonly code = signal('');
  protected readonly sendingCode = signal(false);
  protected readonly codeSent = signal(false);
  protected readonly confirming = signal(false);
  protected readonly verified = signal(false);
  protected readonly disconnecting = signal(false);
  protected readonly confirmDisconnect = signal(false);
  protected readonly changingRecipient = signal(false);

  // Passo 3: grupo do WhatsApp (opcional).
  protected readonly groupsFetched = signal(false);
  protected readonly groupsLoading = signal(false);
  protected readonly groupsLoadFailed = signal(false);
  protected readonly groups = signal<GroupOption[]>([]);
  protected readonly groupFilter = signal('');
  protected readonly activeGroupName = signal<string | null>(null);
  protected readonly settingGroupJid = signal<string | null>(null);
  protected readonly disablingGroup = signal(false);
  protected readonly filteredGroups = computed(() => {
    const q = this.groupFilter().trim().toLowerCase();
    if (!q) return this.groups();
    return this.groups().filter((g) => (g.name ?? g.jid).toLowerCase().includes(q));
  });
  /** Segundos restantes de validade do código (contagem a partir do expiresAt do backend). */
  protected readonly remainingSec = signal(0);
  private countdown: ReturnType<typeof setInterval> | null = null;

  /** E.164 (mesmo formato exigido no backend) — valida antes de enviar (evita 400). */
  protected readonly phoneValid = computed(() => E164_RE.test(this.phone()));
  protected readonly codeValid = computed(() => CODE_RE.test(this.code()));
  /** Código enviado mas já expirou → precisa reenviar. */
  protected readonly codeExpired = computed(() => this.codeSent() && this.remainingSec() <= 0);
  /** Validade restante formatada (M:SS) p/ a tela. */
  protected readonly remainingLabel = computed(() => {
    const total = this.remainingSec();
    const m = Math.floor(total / 60);
    const s = total % 60;
    return `${m}:${s.toString().padStart(2, '0')}`;
  });
  /** Destinatário = número do próprio agente? (WhatsApp não entrega msg pra si mesmo.) */
  protected readonly recipientIsPaired = computed(() => {
    const paired = this.pairedPhone();
    return paired !== null && onlyDigits(paired) === onlyDigits(this.phone());
  });

  constructor() {
    this.destroyRef.onDestroy(() => {
      this.destroyed = true;
      this.stopCountdown();
    });
    this.api.status(true).subscribe({
      next: (s) => {
        if (!this.connectStarted) this.applyState(s); // não sobrescreve um QR recém-obtido
        this.loading.set(false);
      },
      error: () => this.loading.set(false),
    });
    // reflete o destinatário já verificado (persiste ao reabrir a tela). silent:
    // é carga de fundo — falha não deve estourar toast ao abrir a tela.
    this.api.getRecipient(true).subscribe({
      next: (r) => {
        if (r.recipient?.verified) {
          this.verified.set(true);
          this.phone.set(r.recipient.phone);
        }
      },
      error: () => {},
    });
    // reflete o grupo já ativo (se algum) — silent: carga de fundo ao abrir a tela.
    this.loadGroups(true);
  }

  private startCountdown(expiresAtIso: string): void {
    this.stopCountdown();
    const expiresMs = Date.parse(expiresAtIso);
    if (Number.isNaN(expiresMs)) {
      this.remainingSec.set(0); // ISO inválido → trata como expirado (força reenviar)
      return;
    }
    const tick = (): void => {
      this.remainingSec.set(Math.max(0, Math.round((expiresMs - Date.now()) / 1000)));
      if (this.remainingSec() <= 0) this.stopCountdown();
    };
    tick();
    this.countdown = setInterval(tick, 1000);
  }
  private stopCountdown(): void {
    if (this.countdown) {
      clearInterval(this.countdown);
      this.countdown = null;
    }
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

  protected disconnect(): void {
    this.disconnecting.set(true);
    this.api.disconnect().subscribe({
      next: (s) => {
        this.disconnecting.set(false);
        this.confirmDisconnect.set(false);
        this.connectStarted = false; // volta ao fluxo inicial (parear de novo)
        // limpa a verificação em andamento (o passo 2 fica dimmed sem canal).
        this.stopCountdown();
        this.codeSent.set(false);
        this.code.set('');
        this.applyState(s); // status disconnected → some o "conectado", mostra "Conectar"
        toast.success('WhatsApp desconectado');
      },
      // erro amigável já vem do interceptor global.
      error: () => this.disconnecting.set(false),
    });
  }

  protected onPhone(event: Event): void {
    this.phone.set(normalizePhone((event.target as HTMLInputElement).value));
  }
  protected onCode(event: Event): void {
    // só dígitos (o backend espera 6 dígitos).
    this.code.set((event.target as HTMLInputElement).value.replace(/\D/g, ''));
  }

  protected sendCode(): void {
    this.sendingCode.set(true);
    this.code.set('');
    this.api.startVerification({ phone: this.phone() }).subscribe({
      next: (r) => {
        this.sendingCode.set(false);
        this.sentPhone.set(this.phone()); // congela o número que recebeu o código
        this.codeSent.set(true);
        this.startCountdown(r.expiresAt); // valida a partir do expiresAt do backend
        toast.success('Código enviado para o seu WhatsApp');
      },
      // erro amigável já vem do interceptor global.
      error: () => this.sendingCode.set(false),
    });
  }

  protected confirm(): void {
    this.confirming.set(true);
    // confirma contra o número que recebeu o código (não o que está no input agora).
    this.api.confirmVerification({ phone: this.sentPhone(), code: this.code() }).subscribe({
      next: (r) => {
        this.confirming.set(false);
        this.verified.set(r.verified);
        // resposta 200 com código errado não é erro HTTP → toast explícito.
        if (r.verified) {
          this.stopCountdown();
          toast.success('Número confirmado');
        } else {
          toast.error('Código inválido. Peça um novo e tente de novo.');
        }
      },
      // erro amigável já vem do interceptor global.
      error: () => this.confirming.set(false),
    });
  }

  /** Remove o destinatário verificado e volta ao passo de informar o número. */
  protected trocarNumero(): void {
    this.changingRecipient.set(true);
    this.api.removeRecipient().subscribe({
      next: () => {
        this.changingRecipient.set(false);
        this.verified.set(false);
        this.codeSent.set(false);
        this.code.set('');
        this.phone.set('');
        this.stopCountdown();
        toast.success('Número removido — informe outro para receber');
      },
      error: () => this.changingRecipient.set(false),
    });
  }

  protected onGroupFilter(event: Event): void {
    this.groupFilter.set((event.target as HTMLInputElement).value);
  }

  /** Busca os grupos do número + qual está ativo (silent = carga de fundo, sem toast de erro). */
  protected loadGroups(silent = false): void {
    this.groupsLoading.set(true);
    this.groupsLoadFailed.set(false);
    this.api.listGroups(silent).subscribe({
      next: (r) => {
        this.groupsLoading.set(false);
        this.groupsFetched.set(true);
        this.groups.set(r.groups);
        const active = r.activeGroupJid ? (r.groups.find((g) => g.jid === r.activeGroupJid) ?? null) : null;
        // sem nome resolvido (ex: canal desconectado no momento da busca) → rótulo
        // amigável, nunca o JID técnico cru (§13 UX — sem jargão).
        this.activeGroupName.set(active ? (active.name ?? active.jid) : r.activeGroupJid ? 'Grupo configurado' : null);
      },
      error: () => {
        this.groupsLoading.set(false);
        this.groupsLoadFailed.set(true);
      },
    });
  }

  protected activateGroup(g: GroupOption): void {
    this.settingGroupJid.set(g.jid);
    this.api.setGroup({ groupJid: g.jid, ...(g.name ? { name: g.name } : {}) }).subscribe({
      next: (r) => {
        this.settingGroupJid.set(null);
        if (!r.active) {
          toast.error('Não consegui ativar o grupo agora. Tenta de novo?');
          return;
        }
        this.activeGroupName.set(r.name ?? r.groupJid);
        toast.success('Grupo ativado — o agente já responde por lá');
      },
      error: () => this.settingGroupJid.set(null),
    });
  }

  protected disableGroup(): void {
    this.disablingGroup.set(true);
    this.api.disableGroup().subscribe({
      next: (r) => {
        this.disablingGroup.set(false);
        if (r.active) {
          toast.error('Não consegui desligar o grupo agora. Tenta de novo?');
          return;
        }
        this.activeGroupName.set(null);
        toast.success('Grupo desligado — avisos voltam pro seu WhatsApp');
      },
      error: () => this.disablingGroup.set(false),
    });
  }

  private applyState(s: ChannelStateOutput): void {
    const isConnected = s.status === 'connected';
    this.connected.set(isConnected);
    // O QR só vem no `connect` — o polling (connectionState) NÃO o devolve. Então:
    // conectou → limpa; veio QR novo → atualiza; senão MANTÉM o atual (não apagar
    // num poll sem QR, senão o QR "some" e a tela volta pro botão — bug).
    if (isConnected) {
      this.qrCode.set(null);
      if (s.phone) this.pairedPhone.set(s.phone); // só atualiza quando a Evolution informa
    } else {
      if (s.qrCode) this.qrCode.set(s.qrCode);
      this.pairedPhone.set(null);
    }
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
