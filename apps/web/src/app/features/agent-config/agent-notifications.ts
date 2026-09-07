import { ChangeDetectionStrategy, Component, type OnInit, effect, inject, input, output, signal, computed } from '@angular/core';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideChevronDown } from '@ng-icons/lucide';
import { firstValueFrom } from 'rxjs';
import { NumberStepper, UiCheckbox, UiInput, UiSelectBox, UiSwitch, UiSwitchThumb, UiToggleGroup, UiToggleGroupItem, type UiSelectOptionItem } from '@ui';
import { AnalysisApiService } from '@core/api/analysis-api.service';
import type { AgentSummary } from '@core/api/generated';

/** `CadenceSpec` (mesma forma do editor de cadência da análise) — usada pelo pulso. */
type Cadence = NonNullable<AgentSummary['cadence']>;
type CadenceKind = 'daily' | 'twice_daily' | 'weekly' | 'raw';
type Sensitivity = 'low' | 'normal' | 'high';

const HOUR_OPTIONS: readonly UiSelectOptionItem[] = Array.from({ length: 24 }, (_, h) => ({
  value: String(h),
  label: `${String(h).padStart(2, '0')}:00`,
}));
const WEEKDAY_OPTIONS: readonly UiSelectOptionItem[] = [
  { value: '1', label: 'segunda' },
  { value: '2', label: 'terça' },
  { value: '3', label: 'quarta' },
  { value: '4', label: 'quinta' },
  { value: '5', label: 'sexta' },
  { value: '6', label: 'sábado' },
  { value: '0', label: 'domingo' },
];
const CADENCE_KINDS: readonly { value: CadenceKind; label: string }[] = [
  { value: 'daily', label: 'diária' },
  { value: 'twice_daily', label: '2×/dia' },
  { value: 'weekly', label: 'semanal' },
  { value: 'raw', label: 'cron' },
];
const SENSITIVITIES: readonly { value: Sensitivity; label: string }[] = [
  { value: 'low', label: 'baixa' },
  { value: 'normal', label: 'normal' },
  { value: 'high', label: 'alta' },
];

/** Símbolo por moeda (espelha currencySymbol de @trafego/shared — web não importa runtime de shared). */
const CURRENCY_SYMBOLS: Readonly<Record<string, string>> = { BRL: 'R$', USD: '$', EUR: '€', GBP: '£' };

/** Status alertáveis da conta Meta + copy pt-BR (checklist; espelha ACCOUNT_HEALTH_STATUS_LABELS). */
type HealthStatus = NonNullable<NonNullable<AgentSummary['notifyPolicy']['accountHealthAlert']>['statusTriggers']>[number];
const HEALTH_STATUS_OPTIONS: readonly { value: HealthStatus; label: string }[] = [
  { value: 'disabled', label: 'Conta desativada, parou de veicular anúncios' },
  { value: 'unsettled', label: 'Pagamento pendente' },
  { value: 'pending_settlement', label: 'Cobrança pendente' },
  { value: 'grace_period', label: 'Pagamento atrasado, conta em período de carência' },
  { value: 'pending_review', label: 'Conta em revisão de segurança pela Meta' },
  { value: 'pending_closure', label: 'Conta em processo de encerramento' },
  { value: 'closed', label: 'Conta encerrada' },
  { value: 'unknown', label: 'Status não reconhecido (novo código da Meta)' },
];
type SpendSource = 'meta_cap' | 'custom';

/**
 * Proatividade (F4d): o que o agente manda SEM ser perguntado. Pulso (resumo do dia —
 * ontem + hoje até agora —, cadência própria — mesmo editor da cadência da análise), alerta (aviso de mudança
 * material, sensibilidade + intervalo mínimo) e o aviso após cada análise agendada.
 * Componente próprio (salva sua fatia), mesmo padrão de app-agent-autonomy/guardrails.
 */
@Component({
  selector: 'app-agent-notifications',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [NgIcon, NumberStepper, UiCheckbox, UiInput, UiSelectBox, UiSwitch, UiSwitchThumb, UiToggleGroup, UiToggleGroupItem],
  providers: [provideIcons({ lucideChevronDown })],
  template: `
    <section class="flex flex-col gap-4 rounded-lg border border-line bg-panel p-5">
      <div>
        <h2 class="font-brand text-base font-semibold text-ink">O que o agente avisa sozinho</h2>
        <p class="mt-1 text-xs text-muted">
          Além de responder quando você pergunta, o agente pode falar por conta própria.
        </p>
      </div>

      <!-- Pulso -->
      <div class="flex flex-col gap-3 border-t border-line pt-4">
        <label class="flex items-center justify-between gap-3">
          <span class="flex flex-col">
            <span class="text-sm font-medium text-ink">Resumo do dia (pulso)</span>
            <span class="text-xs text-muted">Um retrato de ontem + hoje até agora, na cadência que você definir — mesmo sem recomendação nova. Não deixa a conta "sumir" entre campanhas.</span>
          </span>
          <button appSwitch [ngpSwitchChecked]="pulseEnabled()" (ngpSwitchCheckedChange)="pulseEnabled.set($event)">
            <span appSwitchThumb></span>
          </button>
        </label>
        @if (pulseEnabled()) {
          <div class="flex flex-col gap-2 pl-1">
            <div class="flex flex-wrap gap-2" role="radiogroup" aria-label="Cadência do pulso">
              @for (k of CADENCE_KINDS; track k.value) {
                <button
                  type="button"
                  role="radio"
                  [attr.aria-checked]="pulseCadenceKind() === k.value"
                  (click)="pulseCadenceKind.set(k.value)"
                  class="rounded-md border px-3 py-1.5 text-sm font-medium transition hover:border-accent/40"
                  [class.border-accent]="pulseCadenceKind() === k.value"
                  [class.bg-accent-soft]="pulseCadenceKind() === k.value"
                  [class.text-ink]="pulseCadenceKind() === k.value"
                  [class.border-line]="pulseCadenceKind() !== k.value"
                  [class.text-muted]="pulseCadenceKind() !== k.value"
                >
                  {{ k.label }}
                </button>
              }
            </div>
            @if (pulseCadenceKind() === 'daily') {
              <div class="flex items-center gap-2 text-sm text-ink">às
                <div class="w-28"><app-ui-select [options]="hourOptions" [value]="pulseHourStr()" (valueChange)="onPulseHour($event)" /></div>
              </div>
            }
            @if (pulseCadenceKind() === 'twice_daily') {
              <div class="flex flex-wrap items-center gap-2 text-sm text-ink">às
                <div class="w-28"><app-ui-select [options]="hourOptions" [value]="pulseHourStr()" (valueChange)="onPulseHour($event)" /></div>
                e
                <div class="w-28"><app-ui-select [options]="hourOptions" [value]="pulseHour2Str()" (valueChange)="onPulseHour2($event)" /></div>
              </div>
            }
            @if (pulseCadenceKind() === 'weekly') {
              <div class="flex flex-wrap items-center gap-2 text-sm text-ink">toda
                <div class="w-36"><app-ui-select [options]="weekdayOptions" [value]="pulseWeekdayStr()" (valueChange)="onPulseWeekday($event)" /></div>
                às
                <div class="w-28"><app-ui-select [options]="hourOptions" [value]="pulseHourStr()" (valueChange)="onPulseHour($event)" /></div>
              </div>
            }
            @if (pulseCadenceKind() === 'raw') {
              <input
                type="text"
                class="w-full max-w-xs rounded-md border border-line bg-app px-3 py-2 text-sm text-ink"
                placeholder="ex: 0 8 * * 1"
                [value]="pulseCron()"
                (input)="onPulseCron($event)"
              />
              @if (pulseCronInvalid()) {
                <span class="text-xs text-muted">Preencha a expressão cron pra poder salvar.</span>
              }
            }
          </div>
        }
      </div>

      <!-- Alerta -->
      <div class="flex flex-col gap-3 border-t border-line pt-4">
        <label class="flex items-center justify-between gap-3">
          <span class="flex flex-col">
            <span class="text-sm font-medium text-ink">Alerta de mudança material</span>
            <span class="text-xs text-muted">Quando algo muda de verdade na conta (D-1 vs a média), o agente analisa e avisa — nunca sozinho: só quando confirma que vale a pena.</span>
          </span>
          <button appSwitch [ngpSwitchChecked]="alertsEnabled()" (ngpSwitchCheckedChange)="alertsEnabled.set($event)">
            <span appSwitchThumb></span>
          </button>
        </label>
        @if (alertsEnabled()) {
          <div class="flex flex-col gap-3 pl-1">
            <div class="flex flex-col gap-1">
              <span [id]="'alert-sensitivity'" class="text-xs text-muted">Sensibilidade</span>
              <div
                appToggleGroup
                ngpToggleGroupType="single"
                layout="segmented"
                [columns]="3"
                [attr.aria-labelledby]="'alert-sensitivity'"
                [ngpToggleGroupValue]="[sensitivity()]"
                (ngpToggleGroupValueChange)="setSensitivity($event)"
              >
                @for (s of SENSITIVITIES; track s.value) {
                  <button appToggleGroupItem tone="accent" [ngpToggleGroupItemValue]="s.value">{{ s.label }}</button>
                }
              </div>
            </div>
            <label class="flex flex-col gap-1">
              <span class="text-xs text-muted">Intervalo mínimo entre alertas</span>
              <span class="flex items-center gap-1">
                <input appInput type="number" appNumberStepper inputmode="numeric" min="1" class="w-20" [value]="throttleHours()" (input)="onThrottle($event)" />
                <span class="text-xs text-muted">horas</span>
              </span>
            </label>
          </div>
        }
      </div>

      <!-- Aviso após análise -->
      <div class="border-t border-line pt-4">
        <label class="flex items-center justify-between gap-3">
          <span class="flex flex-col">
            <span class="text-sm font-medium text-ink">Aviso após cada análise agendada</span>
            <span class="text-xs text-muted">Mensagem no WhatsApp quando a análise automática encontra algo pra sugerir.</span>
          </span>
          <button appSwitch [ngpSwitchChecked]="runPushEnabled()" (ngpSwitchCheckedChange)="runPushEnabled.set($event)">
            <span appSwitchThumb></span>
          </button>
        </label>
      </div>

      <!-- Reativação (pivô): conta parada volta a rodar -->
      <div class="border-t border-line pt-4">
        <label class="flex items-center justify-between gap-3">
          <span class="flex flex-col">
            <span class="text-sm font-medium text-ink">Avisar quando a conta voltar a rodar</span>
            <span class="text-xs text-muted">Se a conta ficar parada e depois voltar a gastar, o agente avisa e já roda a primeira análise.</span>
          </span>
          <button appSwitch [ngpSwitchChecked]="reactivationEnabled()" (ngpSwitchCheckedChange)="reactivationEnabled.set($event)">
            <span appSwitchThumb></span>
          </button>
        </label>
      </div>

      <!-- Saúde da conta Meta: desativação / teto de gasto / saldo / pagamento -->
      <div class="flex flex-col gap-3 border-t border-line pt-4">
        <label class="flex items-center justify-between gap-3">
          <span class="flex flex-col">
            <span class="text-sm font-medium text-ink">Avisar se a conta Meta tiver problema</span>
            <span class="text-xs text-muted">Conta desativada, teto de gasto batido ou pagamento recusado, avisa na hora, sem esperar o resumo do dia.</span>
          </span>
          <button appSwitch [ngpSwitchChecked]="accountHealthEnabled()" (ngpSwitchCheckedChange)="accountHealthEnabled.set($event)">
            <span appSwitchThumb></span>
          </button>
        </label>
        @if (accountHealthEnabled()) {
          <div class="flex flex-col gap-4 pl-1">
            <!-- status: por padrão avisa em qualquer estado ruim; escolha fina em divulgação progressiva (fechada) -->
            <div class="flex flex-col gap-2">
              <span class="text-xs text-muted">Avisa em qualquer estado ruim da conta.</span>
              <button
                type="button"
                class="flex w-fit items-center gap-1.5 text-xs font-medium text-accent-strong transition hover:text-accent"
                [attr.aria-expanded]="advancedStatusOpen()"
                (click)="advancedStatusOpen.set(!advancedStatusOpen())"
              >
                Escolher exatamente quais
                <ng-icon
                  name="lucideChevronDown"
                  size="14"
                  class="transition-transform motion-safe:duration-200"
                  [class.rotate-180]="advancedStatusOpen()"
                  aria-hidden="true"
                />
              </button>
              @if (advancedStatusOpen()) {
                <div class="flex flex-col gap-1 pt-1">
                  @for (s of HEALTH_STATUS_OPTIONS; track s.value) {
                    <label class="flex items-center gap-2.5 text-sm text-ink">
                      <button
                        appCheckbox
                        [ngpCheckboxChecked]="statusTriggers().has(s.value)"
                        (ngpCheckboxCheckedChange)="toggleStatusTrigger(s.value)"
                        [attr.aria-label]="s.label"
                      ></button>
                      {{ s.label }}
                    </label>
                  }
                </div>
              }
            </div>

            <!-- teto de gasto + saldo lado a lado (dois limites de verba, destaque igual) -->
            <div class="grid grid-cols-1 gap-3 border-t border-line pt-3 sm:grid-cols-2">
              <!-- teto de gasto -->
              <div class="flex flex-col gap-2 rounded-md border border-line p-3">
                <span class="text-sm font-medium text-ink">Teto de gasto</span>
                <span class="text-xs text-muted">A Meta para de veicular quando o gasto total da conta chega no teto. Te aviso antes de chegar lá.</span>
                <div class="flex flex-wrap gap-2 pt-1" role="radiogroup" aria-label="Fonte do teto de gasto">
                  @for (opt of SPEND_SOURCES; track opt.value) {
                    <button
                      type="button"
                      role="radio"
                      [attr.aria-checked]="spendSource() === opt.value"
                      (click)="spendSource.set(opt.value)"
                      class="rounded-md border px-3 py-1.5 text-sm font-medium transition hover:border-accent/40"
                      [class.border-accent]="spendSource() === opt.value"
                      [class.bg-accent-soft]="spendSource() === opt.value"
                      [class.text-ink]="spendSource() === opt.value"
                      [class.border-line]="spendSource() !== opt.value"
                      [class.text-muted]="spendSource() !== opt.value"
                    >
                      {{ opt.label }}
                    </button>
                  }
                </div>
                @if (spendSource() === 'custom') {
                  <label class="flex flex-col gap-1 pt-1">
                    <span class="text-xs text-muted">Avisar quando o gasto total passar de</span>
                    <span class="flex items-center gap-1 text-sm text-ink">
                      {{ currencySymbol() }}
                      <input appInput type="number" appNumberStepper inputmode="numeric" min="1" class="w-28" [value]="customSpendThreshold()" (input)="onCustomSpend($event)" />
                    </span>
                  </label>
                  @if (spendInvalid()) {
                    <span class="text-xs text-muted">Informe um valor maior que zero pra poder salvar.</span>
                  }
                }
              </div>

              <!-- saldo acabando: toggle sempre operável (liberdade total); ressalva contextual do cartão -->
              <div class="flex flex-col gap-2 rounded-md border border-line p-3">
                <label class="flex items-center justify-between gap-3">
                  <span class="flex flex-col">
                    <span class="text-sm font-medium text-ink">Saldo acabando</span>
                    <span class="text-xs text-muted">Quando o saldo chega perto do fim, os anúncios param até você recarregar.</span>
                  </span>
                  <button appSwitch [ngpSwitchChecked]="balanceEnabled()" (ngpSwitchCheckedChange)="balanceEnabled.set($event)">
                    <span appSwitchThumb></span>
                  </button>
                </label>
                @if (balanceCaveat()) {
                  <span class="text-xs text-muted">{{ balanceCaveat() }}</span>
                }
                @if (balanceEnabled()) {
                  <label class="flex flex-col gap-1 pt-1">
                    <span class="text-xs text-muted">Avisar quando ficar abaixo de</span>
                    <span class="flex items-center gap-1 text-sm text-ink">
                      {{ currencySymbol() }}
                      <input appInput type="number" appNumberStepper inputmode="numeric" min="1" class="w-28" [value]="customBalanceThreshold()" (input)="onCustomBalance($event)" />
                    </span>
                  </label>
                  @if (balanceInvalid()) {
                    <span class="text-xs text-muted">Informe um valor maior que zero pra poder salvar.</span>
                  }
                }
              </div>
            </div>
          </div>
        }
      </div>
    </section>
  `,
})
export class AgentNotifications implements OnInit {
  private readonly api = inject(AnalysisApiService);

  readonly accountId = input.required<string>();
  readonly dirtyChange = output<boolean>();

  protected readonly hourOptions = HOUR_OPTIONS;
  protected readonly weekdayOptions = WEEKDAY_OPTIONS;
  protected readonly CADENCE_KINDS = CADENCE_KINDS;
  protected readonly SENSITIVITIES = SENSITIVITIES;

  protected readonly pulseEnabled = signal(false);
  protected readonly pulseCadenceKind = signal<CadenceKind>('daily');
  protected readonly pulseHour = signal(8);
  protected readonly pulseHour2 = signal(18);
  protected readonly pulseWeekday = signal(1);
  protected readonly pulseCron = signal('');

  protected readonly alertsEnabled = signal(false);
  protected readonly sensitivity = signal<Sensitivity>('normal');
  protected readonly throttleHours = signal('6');

  protected readonly runPushEnabled = signal(true);
  protected readonly reactivationEnabled = signal(false);

  protected readonly HEALTH_STATUS_OPTIONS = HEALTH_STATUS_OPTIONS;
  protected readonly SPEND_SOURCES: readonly { value: SpendSource; label: string }[] = [
    { value: 'meta_cap', label: 'Teto da Meta' },
    { value: 'custom', label: 'Valor que eu defino' },
  ];
  protected readonly accountHealthEnabled = signal(true);
  // divulgação progressiva: fechada por padrão (quase ninguém edita os 8 status).
  protected readonly advancedStatusOpen = signal(false);
  protected readonly statusTriggers = signal<Set<HealthStatus>>(new Set(HEALTH_STATUS_OPTIONS.map((o) => o.value)));
  protected readonly spendSource = signal<SpendSource>('meta_cap');
  protected readonly customSpendThreshold = signal('');
  protected readonly balanceEnabled = signal(false);
  protected readonly customBalanceThreshold = signal('');
  private readonly accountCurrency = signal<string | null>(null);
  // pré-pago × cartão/fatura — só orienta a ressalva do saldo (nunca desabilita o toggle).
  private readonly fundingType = signal<'stored_balance' | 'other' | null>(null);
  // ressalva do saldo é CONTEXTUAL: só aparece em conta de cartão/fatura, onde o saldo
  // mostrado é gasto-não-cobrado (não disponível) e o aviso costuma não fazer sentido. Em
  // pré-pago (ou ainda não sincronizada) não há ressalva. O toggle segue operável nos dois.
  protected readonly balanceCaveat = computed(() =>
    this.fundingType() === 'other'
      ? 'Sua conta é cobrada por cartão ou fatura, então esse saldo varia entre as cobranças e o aviso pode não fazer sentido. Você decide se quer ligar mesmo assim.'
      : '',
  );
  // toUpperCase espelha currencySymbol de @trafego/shared (código ISO pode vir minúsculo);
  // fallback = o próprio código (honesto), igual ao shared.
  protected readonly currencySymbol = computed(() => {
    const cur = (this.accountCurrency() ?? 'BRL').toUpperCase();
    return CURRENCY_SYMBOLS[cur] ?? cur;
  });

  protected toggleStatusTrigger(s: HealthStatus): void {
    const next = new Set(this.statusTriggers());
    if (next.has(s)) next.delete(s);
    else next.add(s);
    this.statusTriggers.set(next);
  }
  protected onCustomSpend(e: Event): void {
    this.customSpendThreshold.set((e.target as HTMLInputElement).value);
  }
  protected onCustomBalance(e: Event): void {
    this.customBalanceThreshold.set((e.target as HTMLInputElement).value);
  }

  protected readonly pulseHourStr = computed(() => String(this.pulseHour()));
  protected readonly pulseHour2Str = computed(() => String(this.pulseHour2()));
  protected readonly pulseWeekdayStr = computed(() => String(this.pulseWeekday()));
  protected onPulseHour(v: string): void {
    this.pulseHour.set(Number(v));
  }
  protected onPulseHour2(v: string): void {
    this.pulseHour2.set(Number(v));
  }
  protected onPulseWeekday(v: string): void {
    this.pulseWeekday.set(Number(v));
  }
  protected onPulseCron(e: Event): void {
    this.pulseCron.set((e.target as HTMLInputElement).value);
  }
  protected onThrottle(e: Event): void {
    this.throttleHours.set((e.target as HTMLInputElement).value);
  }
  protected setSensitivity(value: string | string[]): void {
    const v = (Array.isArray(value) ? value[0] : value) as Sensitivity;
    if (v) this.sensitivity.set(v);
  }

  /** Compõe o `CadenceSpec` do pulso a partir do sub-estado (mesma forma do CadenceSpec da análise). */
  protected readonly pulseCadenceSpec = computed<Cadence>(() => {
    switch (this.pulseCadenceKind()) {
      case 'daily':
        return { kind: 'daily', hour: this.pulseHour() };
      case 'twice_daily':
        return { kind: 'twice_daily', hours: [this.pulseHour(), this.pulseHour2()] };
      case 'weekly':
        return { kind: 'weekly', weekday: this.pulseWeekday(), hour: this.pulseHour() };
      case 'raw':
        return { kind: 'raw', cron: this.pulseCron().trim() };
    }
  });

  /** raw sem cron = estado inválido (mesma regra de `cadenceFromToolCall`: nunca inventa cadência). */
  protected readonly pulseCronInvalid = computed(
    () => this.pulseCadenceKind() === 'raw' && this.pulseCron().trim().length === 0,
  );

  protected readonly saving = signal(false);
  protected readonly loaded = signal(false);
  private readonly baseline = signal('');
  private readonly sig = computed(
    () =>
      `${this.pulseEnabled()}|${JSON.stringify(this.pulseCadenceSpec())}|${this.alertsEnabled()}|${this.sensitivity()}|${this.throttleHours()}|${this.runPushEnabled()}|${this.reactivationEnabled()}|${this.accountHealthEnabled()}|${[...this.statusTriggers()].sort().join(',')}|${this.spendSource()}|${this.customSpendThreshold()}|${this.balanceEnabled()}|${this.customBalanceThreshold()}`,
  );
  /** teto customizado exige valor > 0 (nunca inventa limiar) — só quando o campo está VISÍVEL. */
  protected readonly spendInvalid = computed(
    () => this.accountHealthEnabled() && this.spendSource() === 'custom' && !(Number(this.customSpendThreshold()) > 0),
  );
  /** saldo customizado idem — só conta quando o toggle de saldo está ligado E visível. */
  protected readonly balanceInvalid = computed(
    () => this.accountHealthEnabled() && this.balanceEnabled() && !(Number(this.customBalanceThreshold()) > 0),
  );
  // gate no accountHealthEnabled: com a saúde DESLIGADA, os limiares custom ficam ocultos e
  // NÃO devem travar o save (senão o usuário não consegue nem desligar — achado da revisão).
  private readonly healthInvalid = computed(() => this.spendInvalid() || this.balanceInvalid());
  readonly dirty = computed(() => this.sig() !== this.baseline() && !this.pulseCronInvalid() && !this.healthInvalid());

  constructor() {
    // baseline = estado inicial → dirty começa false (Save só habilita após mudança).
    this.baseline.set(this.sig());
    effect(() => this.dirtyChange.emit(this.dirty()));
  }

  ngOnInit(): void {
    // secundária (a página-mãe já busca o agente): silenciosa p/ não duplicar toast.
    this.api.getAgent(this.accountId(), { silent: true }).subscribe({ next: (a) => this.seed(a), error: () => {} });
  }

  private seed(a: AgentSummary): void {
    const n = a.notifyPolicy;
    this.pulseEnabled.set(n.pulse.enabled);
    this.applyPulseCadence(n.pulse.cadence as Cadence);
    this.alertsEnabled.set(n.alerts.enabled);
    this.sensitivity.set(n.alerts.sensitivity as Sensitivity);
    this.throttleHours.set(String(n.alerts.throttleHours));
    this.runPushEnabled.set(n.runPush.enabled);
    this.reactivationEnabled.set(n.reactivation?.enabled ?? false);
    this.accountCurrency.set(a.currency);
    this.fundingType.set(a.fundingType);
    const ah = n.accountHealthAlert;
    this.accountHealthEnabled.set(ah?.enabled ?? true);
    this.statusTriggers.set(new Set((ah?.statusTriggers ?? HEALTH_STATUS_OPTIONS.map((o) => o.value)) as HealthStatus[]));
    this.spendSource.set((ah?.spendThreshold?.source ?? 'meta_cap') as SpendSource);
    this.customSpendThreshold.set(ah?.spendThreshold?.customValueMajor != null ? String(ah.spendThreshold.customValueMajor) : '');
    this.balanceEnabled.set(ah?.balanceThreshold?.enabled ?? false);
    this.customBalanceThreshold.set(ah?.balanceThreshold?.customValueMajor != null ? String(ah.balanceThreshold.customValueMajor) : '');
    this.baseline.set(this.sig());
    this.loaded.set(true);
  }

  /** Decompõe o `CadenceSpec` salvo do pulso no sub-estado do editor. */
  private applyPulseCadence(cadence: Cadence): void {
    this.pulseCadenceKind.set(cadence.kind);
    if (cadence.kind === 'daily') this.pulseHour.set(cadence.hour);
    if (cadence.kind === 'twice_daily') {
      this.pulseHour.set(cadence.hours[0]);
      this.pulseHour2.set(cadence.hours[1]);
    }
    if (cadence.kind === 'weekly') {
      this.pulseWeekday.set(cadence.weekday);
      this.pulseHour.set(cadence.hour);
    }
    if (cadence.kind === 'raw') this.pulseCron.set(cadence.cron);
  }

  /** Salva a fatia (chamada pela save-bar única da página). No-op se não há mudança. */
  async save(): Promise<boolean> {
    if (!this.dirty()) return true;
    this.saving.set(true);
    try {
      const a = await firstValueFrom(
        this.api.saveConfig(this.accountId(), {
          notifyPolicy: {
            pulse: { enabled: this.pulseEnabled(), cadence: this.pulseCadenceSpec() },
            alerts: {
              enabled: this.alertsEnabled(),
              sensitivity: this.sensitivity(),
              throttleHours: Math.max(1, Number(this.throttleHours()) || 6),
            },
            runPush: { enabled: this.runPushEnabled() },
            reactivation: { enabled: this.reactivationEnabled() },
            accountHealthAlert: {
              enabled: this.accountHealthEnabled(),
              statusTriggers: [...this.statusTriggers()],
              spendThreshold:
                this.spendSource() === 'custom'
                  ? { source: 'custom', customValueMajor: Number(this.customSpendThreshold()) }
                  : { source: 'meta_cap' },
              balanceThreshold: this.balanceEnabled()
                ? { enabled: true, customValueMajor: Number(this.customBalanceThreshold()) }
                : { enabled: false },
            },
          },
        }),
      );
      this.seed(a);
    } finally {
      this.saving.set(false);
    }
    return true;
  }
}
