import { ChangeDetectionStrategy, Component, type OnInit, inject, input, signal, computed } from '@angular/core';
import { toast } from 'ngx-sonner';
import { UiButton, UiInput, UiSelectBox, UiSwitch, UiSwitchThumb, UiToggleGroup, UiToggleGroupItem, type UiSelectOptionItem } from '@ui';
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

/**
 * Proatividade (F4d): o que o agente manda SEM ser perguntado. Pulso (resumo do dia —
 * ontem + hoje até agora —, cadência própria — mesmo editor da cadência da análise), alerta (aviso de mudança
 * material, sensibilidade + intervalo mínimo) e o aviso após cada análise agendada.
 * Componente próprio (salva sua fatia), mesmo padrão de app-agent-autonomy/guardrails.
 */
@Component({
  selector: 'app-agent-notifications',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [UiButton, UiInput, UiSelectBox, UiSwitch, UiSwitchThumb, UiToggleGroup, UiToggleGroupItem],
  template: `
    <section class="flex flex-col gap-4 rounded-lg border border-line bg-panel p-5">
      <div class="flex items-start justify-between gap-3">
        <div>
          <h2 class="font-brand text-base font-semibold text-ink">O que o agente avisa sozinho</h2>
          <p class="mt-1 text-xs text-muted">
            Além de responder quando você pergunta, o agente pode falar por conta própria.
          </p>
        </div>
        <button appButton size="sm" [disabled]="saving() || !dirty() || !loaded()" (click)="save()">
          {{ saving() ? 'Salvando…' : 'Salvar' }}
        </button>
      </div>

      <!-- Pulso -->
      <div class="flex flex-col gap-3 border-t border-line pt-4">
        <label class="flex items-center justify-between gap-3">
          <span class="flex flex-col">
            <span class="text-sm font-medium text-ink">Resumo do dia (pulso)</span>
            <span class="text-xs text-muted">Um retrato de ontem + hoje até agora, na cadência que você definir — mesmo sem recomendação nova. Não deixa a conta "sumir" entre lançamentos.</span>
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
                <input appInput type="number" inputmode="numeric" min="1" class="w-20" [value]="throttleHours()" (input)="onThrottle($event)" />
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
    </section>
  `,
})
export class AgentNotifications implements OnInit {
  private readonly api = inject(AnalysisApiService);

  readonly accountId = input.required<string>();

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
      `${this.pulseEnabled()}|${JSON.stringify(this.pulseCadenceSpec())}|${this.alertsEnabled()}|${this.sensitivity()}|${this.throttleHours()}|${this.runPushEnabled()}`,
  );
  protected readonly dirty = computed(() => this.sig() !== this.baseline() && !this.pulseCronInvalid());

  constructor() {
    // baseline = estado inicial → dirty começa false (Save só habilita após mudança).
    this.baseline.set(this.sig());
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

  protected save(): void {
    if (!this.dirty()) return;
    this.saving.set(true);
    this.api
      .saveConfig(this.accountId(), {
        notifyPolicy: {
          pulse: { enabled: this.pulseEnabled(), cadence: this.pulseCadenceSpec() },
          alerts: {
            enabled: this.alertsEnabled(),
            sensitivity: this.sensitivity(),
            throttleHours: Math.max(1, Number(this.throttleHours()) || 6),
          },
          runPush: { enabled: this.runPushEnabled() },
        },
      })
      .subscribe({
        next: (a) => {
          this.seed(a);
          this.saving.set(false);
          toast.success('Notificações salvas');
        },
        error: () => this.saving.set(false),
      });
  }
}
