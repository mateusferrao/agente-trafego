import { ChangeDetectionStrategy, Component, type OnInit, type WritableSignal, effect, inject, input, output, signal, computed } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { NumberStepper, UiInput, UiSwitch, UiSwitchThumb } from '@ui';
import { AnalysisApiService } from '@core/api/analysis-api.service';
import type { AgentSummary } from '@core/api/generated';
import { currencySymbol } from '@app/shared/format';

type ActionType = 'pause_entity' | 'resume_entity' | 'adjust_budget' | 'set_status';

/** Guardrails (5a): rede de segurança independente da autonomia — sempre vale na escrita.
 *  As "ações permitidas" (on/off por tipo) migraram p/ a lista única em "Até onde o agente
 *  pode ir" (A3, bindings) — aqui o allowedActions é só preservado no save (coluna estável). */
@Component({
  selector: 'app-agent-guardrails',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [NumberStepper, UiInput, UiSwitch, UiSwitchThumb],
  template: `
    <section class="flex flex-col gap-4 rounded-lg border border-line bg-panel p-5">
      <div>
        <h2 class="font-brand text-base font-semibold text-ink">Limites de segurança</h2>
        <p class="mt-1 text-xs text-muted">
          A rede que segura o agente mesmo agindo sozinho. Independente da autonomia.
        </p>
      </div>

      <label class="flex items-center justify-between gap-3">
        <span class="flex flex-col">
          <span class="text-sm font-medium text-ink">Modo ensaio (dry-run)</span>
          <span class="text-xs text-muted">Mostra o que faria sem aplicar de verdade. Deixe ligado até confiar.</span>
        </span>
        <button appSwitch [ngpSwitchChecked]="dryRun()" (ngpSwitchCheckedChange)="dryRun.set($event)">
          <span appSwitchThumb></span>
        </button>
      </label>

      <label class="flex items-center justify-between gap-3">
        <span class="flex flex-col">
          <span class="text-sm font-medium text-ink">Trava total (kill-switch)</span>
          <span class="text-xs text-muted">Bloqueia toda ação do agente na conta.</span>
        </span>
        <button appSwitch [ngpSwitchChecked]="killSwitch()" (ngpSwitchCheckedChange)="killSwitch.set($event)">
          <span appSwitchThumb></span>
        </button>
      </label>

      <div class="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <label class="flex flex-col gap-1">
          <span class="text-sm font-medium text-ink">Mudança máx. de orçamento</span>
          <span class="flex items-center gap-1">
            <input appInput type="number" appNumberStepper inputmode="numeric" min="0" max="100" class="w-20" [value]="maxPct()" (input)="onNum(maxPct, $event)" />
            <span class="text-xs text-muted">% por vez</span>
          </span>
        </label>
        <label class="flex flex-col gap-1">
          <span class="text-sm font-medium text-ink">Máx. de entidades por dia</span>
          <input appInput type="number" appNumberStepper inputmode="numeric" min="0" class="w-20" [value]="maxEntities()" (input)="onNum(maxEntities, $event)" />
        </label>
        <label class="flex flex-col gap-1">
          <span class="text-sm font-medium text-ink">Teto de custo de IA</span>
          <span class="flex items-center gap-1">
            <span class="text-xs text-muted">US$</span>
            <input appInput type="number" appNumberStepper inputmode="decimal" min="0" class="w-24" placeholder="sem teto" [value]="llmCap()" (input)="onNum(llmCap, $event)" />
          </span>
        </label>
      </div>

      <div class="flex flex-col gap-3 rounded-lg border border-line p-4">
        <span class="text-sm font-medium text-ink">Limites de criação (gasto novo)</span>
        <span class="text-xs text-muted">Teto de segurança quando o agente cria ou escala campanhas.</span>
        <div class="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <label class="flex flex-col gap-1">
            <span class="text-sm font-medium text-ink">Orçamento novo máx./dia</span>
            <span class="flex items-center gap-1">
              <span class="text-xs text-muted">{{ currencySymbol(currency()) }}</span>
              <input appInput type="number" appNumberStepper inputmode="decimal" min="0" class="w-24" [value]="maxNewDaily()" (input)="onNum(maxNewDaily, $event)" />
            </span>
          </label>
          <label class="flex flex-col gap-1">
            <span class="text-sm font-medium text-ink">Máx. campanhas novas/dia</span>
            <input appInput type="number" appNumberStepper inputmode="numeric" min="0" class="w-20" [value]="maxNewCampaigns()" (input)="onNum(maxNewCampaigns, $event)" />
          </label>
          <label class="flex flex-col gap-1">
            <span class="text-sm font-medium text-ink">Passo de escala</span>
            <span class="flex items-center gap-1">
              <input appInput type="number" appNumberStepper inputmode="numeric" min="0" class="w-20" [value]="scalePct()" (input)="onNum(scalePct, $event)" />
              <span class="text-xs text-muted">% a mais</span>
            </span>
          </label>
        </div>
      </div>
    </section>
  `,
})
export class AgentGuardrails implements OnInit {
  private readonly api = inject(AnalysisApiService);

  readonly accountId = input.required<string>();
  readonly currency = input('BRL');
  readonly dirtyChange = output<boolean>();

  protected readonly currencySymbol = currencySymbol;

  protected readonly dryRun = signal(true);
  protected readonly killSwitch = signal(false);
  protected readonly maxPct = signal('20');
  protected readonly maxEntities = signal('3');
  protected readonly llmCap = signal('');
  protected readonly maxNewDaily = signal('50');
  protected readonly maxNewCampaigns = signal('1');
  protected readonly scalePct = signal('50');
  // preservado (não editável aqui — migrou p/ a lista única): reenviado no save p/ manter
  // a coluna estável (bindings são a fonte autoritativa; allowedActions = fallback vestigial).
  private readonly allowed = signal<ReadonlySet<ActionType>>(new Set(['pause_entity']));

  protected readonly saving = signal(false);
  protected readonly loaded = signal(false);
  private readonly baseline = signal('');
  private readonly sig = computed(
    () =>
      `${this.dryRun()}|${this.killSwitch()}|${this.maxPct()}|${this.maxEntities()}|${this.llmCap()}|${this.maxNewDaily()}|${this.maxNewCampaigns()}|${this.scalePct()}`,
  );
  readonly dirty = computed(() => this.sig() !== this.baseline());

  constructor() {
    // baseline = estado inicial → dirty começa false (Save só habilita após mudança).
    this.baseline.set(this.sig());
    effect(() => this.dirtyChange.emit(this.dirty()));
  }

  protected onNum(sig: WritableSignal<string>, e: Event): void {
    sig.set((e.target as HTMLInputElement).value);
  }

  ngOnInit(): void {
    // secundária (a página-mãe já busca o agente): silenciosa p/ não duplicar toast.
    this.api.getAgent(this.accountId(), { silent: true }).subscribe({ next: (a) => this.seed(a), error: () => {} });
  }

  private seed(a: AgentSummary): void {
    const g = a.guardrails;
    this.dryRun.set(g.dryRun);
    this.killSwitch.set(g.killSwitch);
    this.maxPct.set(String(g.maxBudgetChangePct));
    this.maxEntities.set(String(g.maxEntitiesPerDay));
    this.llmCap.set(g.llmCostCapUsd != null ? String(g.llmCostCapUsd) : '');
    if (g.maxNewDailyBudgetMinor != null) this.maxNewDaily.set(String(g.maxNewDailyBudgetMinor / 100));
    if (g.maxNewCampaignsPerDay != null) this.maxNewCampaigns.set(String(g.maxNewCampaignsPerDay));
    if (g.scalePct != null) this.scalePct.set(String(g.scalePct));
    this.allowed.set(new Set(g.allowedActions as ActionType[]));
    this.baseline.set(this.sig());
    this.loaded.set(true);
  }

  private parseInt0(s: string, fallback: number): number {
    const n = Number(s);
    return Number.isFinite(n) ? Math.trunc(n) : fallback;
  }

  /** Salva a fatia (chamada pela save-bar única da página). No-op se não há mudança. */
  async save(): Promise<void> {
    if (!this.dirty()) return;
    this.saving.set(true);
    const cap = this.llmCap().trim();
    const capNum = Number(cap);
    try {
      const a = await firstValueFrom(
        this.api.saveConfig(this.accountId(), {
          guardrails: {
            maxBudgetChangePct: Math.max(0, Math.min(100, this.parseInt0(this.maxPct(), 20))),
            maxEntitiesPerDay: Math.max(0, this.parseInt0(this.maxEntities(), 3)),
            allowedActions: [...this.allowed()],
            dryRun: this.dryRun(),
            killSwitch: this.killSwitch(),
            ...(cap.length > 0 && Number.isFinite(capNum) ? { llmCostCapUsd: Math.max(0, capNum) } : {}),
            maxNewDailyBudgetMinor: Math.max(0, Math.round((Number(this.maxNewDaily()) || 0) * 100)),
            maxNewCampaignsPerDay: Math.max(0, this.parseInt0(this.maxNewCampaigns(), 1)),
            scalePct: Math.max(0, this.parseInt0(this.scalePct(), 50)),
          },
        }),
      );
      this.seed(a);
    } finally {
      this.saving.set(false);
    }
  }
}
