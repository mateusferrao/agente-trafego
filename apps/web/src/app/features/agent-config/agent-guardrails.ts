import { ChangeDetectionStrategy, Component, type OnInit, type WritableSignal, effect, inject, input, output, signal, computed } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { NumberStepper, UiInput, UiSwitch, UiSwitchThumb, UiCheckbox } from '@ui';
import { AnalysisApiService } from '@core/api/analysis-api.service';
import type { AgentSummary } from '@core/api/generated';

type ActionType = 'pause_entity' | 'resume_entity' | 'adjust_budget' | 'set_status';

const ACTION_LABEL: Record<ActionType, string> = {
  pause_entity: 'pausar',
  resume_entity: 'retomar',
  adjust_budget: 'ajustar orçamento',
  set_status: 'mudar status',
};
const ACTIONS: readonly ActionType[] = ['pause_entity', 'resume_entity', 'adjust_budget', 'set_status'];

/** Guardrails (5a): rede de segurança independente da autonomia — sempre vale na escrita. */
@Component({
  selector: 'app-agent-guardrails',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [NumberStepper, UiInput, UiSwitch, UiSwitchThumb, UiCheckbox],
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

      <div class="flex flex-col gap-2">
        <span class="text-sm font-medium text-ink">Ações permitidas</span>
        <span class="text-xs text-muted">Além de subir a autonomia, o tipo precisa estar liberado aqui.</span>
        <div class="flex flex-wrap gap-4">
          @for (a of ACTIONS; track a) {
            <label class="flex items-center gap-2 text-sm text-ink">
              <button appCheckbox [ngpCheckboxChecked]="isAllowed(a)" (ngpCheckboxCheckedChange)="toggleAllowed(a, $event)">
                <svg viewBox="0 0 12 12" fill="none" class="hidden size-3 stroke-panel group-data-[checked]:block">
                  <path d="M2.5 6.5 5 9l4.5-5" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
                </svg>
              </button>
              {{ ACTION_LABEL[a] }}
            </label>
          }
        </div>
      </div>
    </section>
  `,
})
export class AgentGuardrails implements OnInit {
  private readonly api = inject(AnalysisApiService);

  readonly accountId = input.required<string>();
  readonly dirtyChange = output<boolean>();

  protected readonly ACTIONS = ACTIONS;
  protected readonly ACTION_LABEL = ACTION_LABEL;

  protected readonly dryRun = signal(true);
  protected readonly killSwitch = signal(false);
  protected readonly maxPct = signal('20');
  protected readonly maxEntities = signal('3');
  protected readonly llmCap = signal('');
  private readonly allowed = signal<ReadonlySet<ActionType>>(new Set(['pause_entity']));

  protected readonly saving = signal(false);
  protected readonly loaded = signal(false);
  private readonly baseline = signal('');
  private readonly sig = computed(
    () => `${this.dryRun()}|${this.killSwitch()}|${this.maxPct()}|${this.maxEntities()}|${this.llmCap()}|${[...this.allowed()].sort().join(',')}`,
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
  protected isAllowed(a: ActionType): boolean {
    return this.allowed().has(a);
  }
  protected toggleAllowed(a: ActionType, on: boolean): void {
    const next = new Set(this.allowed());
    if (on) next.add(a);
    else next.delete(a);
    this.allowed.set(next);
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
          },
        }),
      );
      this.seed(a);
    } finally {
      this.saving.set(false);
    }
  }
}
