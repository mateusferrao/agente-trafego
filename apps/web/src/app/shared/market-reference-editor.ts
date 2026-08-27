import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  input,
  output,
  signal,
  type WritableSignal,
} from '@angular/core';
import { NumberStepper, UiInput, UiSelectBox } from '@ui';
import type { MarketReference } from '@core/api/generated';

/** Moedas oferecidas no seletor (org). ISO 4217; a conta traz a sua no override. */
const CURRENCIES: readonly { value: string; label: string }[] = [
  { value: 'BRL', label: 'Real (BRL)' },
  { value: 'USD', label: 'Dólar (USD)' },
  { value: 'EUR', label: 'Euro (EUR)' },
  { value: 'GBP', label: 'Libra (GBP)' },
];

interface CostKind {
  readonly key: 'conversation' | 'lead' | 'sale';
  readonly label: string;
}
const COST_KINDS: readonly CostKind[] = [
  { key: 'conversation', label: 'Custo por conversa' },
  { key: 'lead', label: 'Custo por lead' },
  { key: 'sale', label: 'Custo por venda' },
];

const num = (s: string): number | undefined => {
  const t = s.trim();
  if (t.length === 0) return undefined;
  const n = Number(t);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
};

/**
 * Editor da referência de mercado (pivô) — reusado no padrão da org (Configurações)
 * e no override por agente (config da conta). Faixas de custo = superfície primária;
 * CTR/frequência + limiares operacionais (zumbi/baseline) sob "opções avançadas"
 * (§10 divulgação progressiva). Campos em dinheiro valem na moeda escolhida.
 */
@Component({
  selector: 'app-market-reference-editor',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [NumberStepper, UiInput, UiSelectBox],
  template: `
    <div class="flex flex-col gap-4">
      @if (currencyEditable()) {
        <label class="flex flex-col gap-1">
          <span class="text-sm font-medium text-ink">Moeda das faixas</span>
          <span class="text-xs text-muted">As faixas em dinheiro valem para contas nesta moeda.</span>
          <div class="w-56">
            <app-ui-select [options]="CURRENCIES" [value]="currency()" (valueChange)="onCurrency($event)" />
          </div>
        </label>
      } @else {
        <p class="text-xs text-muted">Faixas na moeda da conta: <span class="font-medium text-ink">{{ currency() }}</span></p>
      }

      <div class="flex flex-col gap-3">
        <span class="text-sm font-medium text-ink">Faixas de custo do seu mercado ({{ currency() }})</span>
        <span class="text-xs text-muted">Preencha só o que usa. Vazio = o agente não usa como referência.</span>
        @for (k of COST_KINDS; track k.key) {
          <div class="grid grid-cols-[1fr_auto_auto] items-center gap-2">
            <span class="text-sm text-ink">{{ k.label }}</span>
            <input appInput type="number" appNumberStepper inputmode="decimal" min="0" class="w-24" placeholder="mín"
              [value]="costMin()[k.key]" (input)="onCost(k.key, 'min', $event)" />
            <input appInput type="number" appNumberStepper inputmode="decimal" min="0" class="w-24" placeholder="máx"
              [value]="costMax()[k.key]" (input)="onCost(k.key, 'max', $event)" />
          </div>
        }
      </div>

      <details class="rounded-md border border-line bg-app p-3">
        <summary class="cursor-pointer text-sm font-medium text-ink">Opções avançadas</summary>
        <div class="mt-3 flex flex-col gap-4">
          <div class="flex flex-col gap-2">
            <span class="text-sm font-medium text-ink">Bandas de CTR (%)</span>
            <span class="text-xs text-muted">Referência de plataforma. Vazio = usa o padrão da plataforma.</span>
            <div class="flex flex-wrap gap-2">
              <input appInput type="number" appNumberStepper inputmode="decimal" min="0" class="w-20" placeholder="ok" [value]="ctrOk()" (input)="onStr(ctrOk, $event)" />
              <input appInput type="number" appNumberStepper inputmode="decimal" min="0" class="w-20" placeholder="bom" [value]="ctrGood()" (input)="onStr(ctrGood, $event)" />
              <input appInput type="number" appNumberStepper inputmode="decimal" min="0" class="w-20" placeholder="ótimo" [value]="ctrGreat()" (input)="onStr(ctrGreat, $event)" />
            </div>
          </div>
          <label class="flex flex-col gap-1">
            <span class="text-sm font-medium text-ink">Alerta de frequência</span>
            <span class="text-xs text-muted">Acima disso, público satura. Vazio = padrão da plataforma.</span>
            <input appInput type="number" appNumberStepper inputmode="decimal" min="0" class="w-24" placeholder="2.5" [value]="freq()" (input)="onStr(freq, $event)" />
          </label>
          <label class="flex flex-col gap-1">
            <span class="text-sm font-medium text-ink">Gasto mínimo para "zumbi" ({{ currency() }})</span>
            <span class="text-xs text-muted">Piso de gasto sem retorno para marcar desperdício. Vazio = padrão.</span>
            <input appInput type="number" appNumberStepper inputmode="decimal" min="0" class="w-24" placeholder="50" [value]="zombie()" (input)="onStr(zombie, $event)" />
          </label>
          <div class="flex flex-col gap-2">
            <span class="text-sm font-medium text-ink">Gasto/dia mínimo p/ sinal ({{ currency() }})</span>
            <span class="text-xs text-muted">Piso por sensibilidade do alerta. Vazio = padrão.</span>
            <div class="flex flex-wrap gap-2">
              <input appInput type="number" appNumberStepper inputmode="decimal" min="0" class="w-20" placeholder="baixa" [value]="baseLow()" (input)="onStr(baseLow, $event)" />
              <input appInput type="number" appNumberStepper inputmode="decimal" min="0" class="w-20" placeholder="normal" [value]="baseNormal()" (input)="onStr(baseNormal, $event)" />
              <input appInput type="number" appNumberStepper inputmode="decimal" min="0" class="w-20" placeholder="alta" [value]="baseHigh()" (input)="onStr(baseHigh, $event)" />
            </div>
          </div>
        </div>
      </details>
    </div>
  `,
})
export class MarketReferenceEditor {
  readonly value = input<MarketReference | null>(null);
  /** moeda (org: editável via seletor; agente: fixa = moeda da conta). */
  readonly currencyInput = input<string>('BRL', { alias: 'currency' });
  readonly currencyEditable = input<boolean>(true);
  readonly valueChange = output<MarketReference | null>();

  protected readonly CURRENCIES = CURRENCIES;
  protected readonly COST_KINDS = COST_KINDS;

  protected readonly currency = signal('BRL');
  protected readonly costMin = signal<Record<string, string>>({ conversation: '', lead: '', sale: '' });
  protected readonly costMax = signal<Record<string, string>>({ conversation: '', lead: '', sale: '' });
  protected readonly ctrOk = signal('');
  protected readonly ctrGood = signal('');
  protected readonly ctrGreat = signal('');
  protected readonly freq = signal('');
  protected readonly zombie = signal('');
  protected readonly baseLow = signal('');
  protected readonly baseNormal = signal('');
  protected readonly baseHigh = signal('');

  /** assinatura serializada — dispara a emissão só quando algo muda de fato. */
  private readonly sig = computed(() =>
    JSON.stringify([
      this.currency(),
      this.costMin(),
      this.costMax(),
      this.ctrOk(),
      this.ctrGood(),
      this.ctrGreat(),
      this.freq(),
      this.zombie(),
      this.baseLow(),
      this.baseNormal(),
      this.baseHigh(),
    ]),
  );
  private lastEmitted = '';
  /** JSON do último valor emitido — p/ IGNORAR o eco quando o pai realimenta `[value]`
   *  (senão a re-hidratação zeraria o campo que o usuário está digitando). */
  private lastEmittedValueJson = '';

  constructor() {
    // hidrata a partir do input (value + currency); ignora o eco do próprio valor.
    effect(() => {
      const cur = this.currencyInput();
      const v = this.value();
      if (JSON.stringify(v ?? null) === this.lastEmittedValueJson) return; // eco → não re-hidrata
      this.currency.set(v?.currency ?? cur);
      this.costMin.set(this.readCost(v, 'min'));
      this.costMax.set(this.readCost(v, 'max'));
      this.ctrOk.set(this.numStr(v?.platform?.ctrBands?.ok));
      this.ctrGood.set(this.numStr(v?.platform?.ctrBands?.good));
      this.ctrGreat.set(this.numStr(v?.platform?.ctrBands?.great));
      this.freq.set(this.numStr(v?.platform?.frequencyAlert));
      this.zombie.set(this.numStr(v?.operational?.zombieMinSpend));
      this.baseLow.set(this.numStr(v?.operational?.minBaselineSpend?.low));
      this.baseNormal.set(this.numStr(v?.operational?.minBaselineSpend?.normal));
      this.baseHigh.set(this.numStr(v?.operational?.minBaselineSpend?.high));
      this.lastEmitted = this.sig();
    });
    // emite ao mudar (guardado pela assinatura serializada).
    effect(() => {
      const s = this.sig();
      if (s === this.lastEmitted) return;
      this.lastEmitted = s;
      const built = this.build();
      this.lastEmittedValueJson = JSON.stringify(built ?? null);
      this.valueChange.emit(built);
    });
  }

  private numStr(n: number | undefined | null): string {
    return typeof n === 'number' ? String(n) : '';
  }
  private readCost(v: MarketReference | null, side: 'min' | 'max'): Record<string, string> {
    const out: Record<string, string> = { conversation: '', lead: '', sale: '' };
    for (const k of COST_KINDS) {
      const band = v?.cost?.[k.key];
      if (band) out[k.key] = this.numStr(band[side]);
    }
    return out;
  }

  protected onCurrency(value: string): void {
    this.currency.set(value);
  }
  protected onStr(sig: WritableSignal<string>, e: Event): void {
    sig.set((e.target as HTMLInputElement).value);
  }
  protected onCost(key: string, side: 'min' | 'max', e: Event): void {
    const val = (e.target as HTMLInputElement).value;
    const target = side === 'min' ? this.costMin : this.costMax;
    target.set({ ...target(), [key]: val });
  }

  /** Monta o MarketReference dos campos; null quando nada foi preenchido. */
  private build(): MarketReference | null {
    const cost: Record<string, { min: number; max: number }> = {};
    for (const k of COST_KINDS) {
      const mn = num(this.costMin()[k.key] ?? '');
      const mx = num(this.costMax()[k.key] ?? '');
      if (mn !== undefined && mx !== undefined) cost[k.key] = { min: mn, max: mx };
    }
    const ok = num(this.ctrOk());
    const good = num(this.ctrGood());
    const great = num(this.ctrGreat());
    const ctrBands = ok !== undefined && good !== undefined && great !== undefined ? { ok, good, great } : undefined;
    const frequencyAlert = num(this.freq());
    const zombieMinSpend = num(this.zombie());
    const low = num(this.baseLow());
    const normal = num(this.baseNormal());
    const high = num(this.baseHigh());
    const minBaselineSpend =
      low !== undefined && normal !== undefined && high !== undefined ? { low, normal, high } : undefined;

    const platform =
      ctrBands || frequencyAlert !== undefined
        ? { ...(ctrBands ? { ctrBands } : {}), ...(frequencyAlert !== undefined ? { frequencyAlert } : {}) }
        : undefined;
    const operational =
      zombieMinSpend !== undefined || minBaselineSpend
        ? { ...(zombieMinSpend !== undefined ? { zombieMinSpend } : {}), ...(minBaselineSpend ? { minBaselineSpend } : {}) }
        : undefined;
    const hasCost = Object.keys(cost).length > 0;

    if (!hasCost && !platform && !operational) return null;
    return {
      currency: this.currency(),
      ...(hasCost ? { cost } : {}),
      ...(platform ? { platform } : {}),
      ...(operational ? { operational } : {}),
    };
  }
}
