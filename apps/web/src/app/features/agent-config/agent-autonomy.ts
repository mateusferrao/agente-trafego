import { ChangeDetectionStrategy, Component, type OnInit, effect, inject, input, output, signal, computed } from '@angular/core';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideChevronDown } from '@ng-icons/lucide';
import { firstValueFrom } from 'rxjs';
import { UiToggleGroup, UiToggleGroupItem, UiSwitch, UiSwitchThumb, UiSelectBox } from '@ui';
import { AGENT_NAME } from '@core/brand';
import { AnalysisApiService } from '@core/api/analysis-api.service';
import type { AgentSummary } from '@core/api/generated';

type Level = 'notify' | 'suggest' | 'act_safe' | 'act_full';
type ScalePref = 'ask' | 'raise' | 'duplicate';
type ToolKey = 'pause_entity' | 'resume_entity' | 'set_status' | 'adjust_budget' | 'create_campaign' | 'duplicate_scale';

/** Lista ÚNICA por-ação (A3): on/off das 6 capacidades. As 4 de otimização + as 2 de criação
 *  (gasto novo). Fonte do gate real (agent_tool_bindings) — mesmo on/off que o chat/apply leem. */
const OPTIMIZE_TOOLS: readonly { key: ToolKey; label: string; hint: string }[] = [
  { key: 'pause_entity', label: 'Pausar', hint: 'Parar o gasto de uma campanha, conjunto ou anúncio.' },
  { key: 'resume_entity', label: 'Retomar', hint: 'Voltar a rodar algo que estava pausado.' },
  { key: 'set_status', label: 'Mudar status', hint: 'Ativar ou pausar uma entidade.' },
  { key: 'adjust_budget', label: 'Ajustar orçamento', hint: 'Subir ou cortar o orçamento (±%).' },
];
const CREATE_TOOLS: readonly { key: ToolKey; label: string; hint: string }[] = [
  { key: 'create_campaign', label: 'Criar campanha', hint: 'Montar uma campanha nova do zero (gasto novo).' },
  { key: 'duplicate_scale', label: 'Duplicar para escalar', hint: 'Clonar um vencedor com mais orçamento (gasto novo).' },
];

/** Autonomia POR-AÇÃO (B) — vence a origem. "" (herda) = usa a autonomia por origem acima. */
const ACTION_AUTONOMY_OPTIONS: readonly { value: string; label: string }[] = [
  { value: '', label: 'herda a origem' },
  { value: 'notify', label: 'só avisa' },
  { value: 'suggest', label: 'sugere + OK' },
  { value: 'act_safe', label: 'age no seguro' },
  { value: 'act_full', label: 'age sozinho' },
];

const LEVELS: readonly { value: Level; label: string }[] = [
  { value: 'notify', label: 'só avisa' },
  { value: 'suggest', label: 'sugere + OK' },
  { value: 'act_safe', label: 'age no seguro' },
  { value: 'act_full', label: 'age sozinho' },
];

/** Como resolver o passo AGRESSIVO da escala (Fatia 7): perguntar / sempre subir / sempre duplicar. */
const SCALE_PREFS: readonly { value: ScalePref; label: string }[] = [
  { value: 'ask', label: 'perguntar' },
  { value: 'raise', label: 'subir orçamento' },
  { value: 'duplicate', label: 'duplicar' },
];

/**
 * Autonomia por origem (5a): quanto o agente pode agir sozinho a partir do playbook
 * (regras) × do LLM (análise). Só MORDE quando a escrita estiver ligada — no read-only
 * configura e persiste, mas o agente não age. Componente próprio (salva sua fatia).
 */
@Component({
  selector: 'app-agent-autonomy',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [UiToggleGroup, UiToggleGroupItem, UiSwitch, UiSwitchThumb, UiSelectBox, NgIcon],
  providers: [provideIcons({ lucideChevronDown })],
  template: `
    <section class="flex flex-col gap-4 rounded-lg border border-line bg-panel p-5">
      <div>
        <h2 class="font-brand text-base font-semibold text-ink">Até onde o agente pode ir</h2>
        <p class="mt-1 text-xs text-muted">
          Quanto ele age sozinho, por origem. Só vale quando a escrita estiver ligada — por enquanto
          configura e guarda; agir de verdade vem depois.
        </p>
      </div>

      @for (src of SOURCES; track src.key) {
        <div class="flex flex-col gap-2">
          <span [id]="'autonomy-' + src.key" class="text-sm font-medium text-ink">{{ src.label }}</span>
          <span class="text-xs text-muted">{{ src.hint }}</span>
          <div
            appToggleGroup
            ngpToggleGroupType="single"
            layout="segmented"
            [columns]="4"
            [attr.aria-labelledby]="'autonomy-' + src.key"
            [ngpToggleGroupValue]="[level(src.key)]"
            (ngpToggleGroupValueChange)="setLevel(src.key, $event)"
          >
            @for (l of LEVELS; track l.value) {
              <button appToggleGroupItem tone="accent" [ngpToggleGroupItemValue]="l.value">{{ l.label }}</button>
            }
          </div>
        </div>
      }

      <div class="flex flex-col gap-3 border-t border-line pt-4">
        <button
          type="button"
          class="flex items-center justify-between gap-3 rounded-md border border-line bg-soft/50 px-3 py-2.5 text-left transition hover:border-accent/40 hover:bg-soft"
          [attr.aria-expanded]="showActions()"
          (click)="showActions.set(!showActions())"
        >
          <span class="flex flex-col">
            <span class="text-sm font-medium text-ink">Ações permitidas</span>
            <span class="text-xs text-muted">O que {{ agentName }} pode fazer na conta. Desligue uma e ele não sugere nem executa aquilo.</span>
          </span>
          <ng-icon
            name="lucideChevronDown"
            size="18"
            class="shrink-0 text-muted transition-transform motion-safe:duration-200"
            [class.rotate-180]="showActions()"
            aria-hidden="true"
          />
        </button>

        @if (showActions()) {
          <div class="flex flex-col gap-3">
            @for (t of OPTIMIZE_TOOLS; track t.key) {
              <div class="flex flex-col gap-2 border-b border-line/60 pb-3 last:border-0 last:pb-0">
                <label class="flex items-center justify-between gap-3">
                  <span class="flex flex-col">
                    <span class="text-sm text-ink">{{ t.label }}</span>
                    <span class="text-xs text-muted">{{ t.hint }}</span>
                  </span>
                  <button appSwitch [ngpSwitchChecked]="toolOn(t.key)" (ngpSwitchCheckedChange)="setTool(t.key, $event)">
                    <span appSwitchThumb></span>
                  </button>
                </label>
                @if (toolOn(t.key)) {
                  <div class="flex items-center justify-between gap-3 pl-1">
                    <span class="text-xs text-muted">Autonomia desta ação</span>
                    <app-ui-select
                      class="w-44"
                      [options]="ACTION_AUTONOMY_OPTIONS"
                      [value]="actionLevel(t.key)"
                      (valueChange)="setActionLevel(t.key, $event)"
                    />
                  </div>
                }
              </div>
            }
          </div>

          <div class="flex flex-col gap-3 rounded-lg border border-line p-4">
            <span class="text-xs font-medium uppercase tracking-wide text-muted">Criação (gasto novo)</span>
            @for (t of CREATE_TOOLS; track t.key) {
              <div class="flex flex-col gap-2 border-b border-line/60 pb-3 last:border-0 last:pb-0">
                <label class="flex items-center justify-between gap-3">
                  <span class="flex flex-col">
                    <span class="text-sm text-ink">{{ t.label }}</span>
                    <span class="text-xs text-muted">{{ t.hint }}</span>
                  </span>
                  <button appSwitch [ngpSwitchChecked]="toolOn(t.key)" (ngpSwitchCheckedChange)="setTool(t.key, $event)">
                    <span appSwitchThumb></span>
                  </button>
                </label>
                @if (toolOn(t.key)) {
                  <div class="flex items-center justify-between gap-3 pl-1">
                    <span class="text-xs text-muted">Quando ele pode criar sozinho</span>
                    <app-ui-select
                      class="w-44"
                      [options]="ACTION_AUTONOMY_OPTIONS"
                      [value]="actionLevel(t.key)"
                      (valueChange)="setActionLevel(t.key, $event)"
                    />
                  </div>
                }
              </div>
            }
          </div>
        }
      </div>

      <div class="flex flex-col gap-2 border-t border-line pt-4">
        <span id="autonomy-scale" class="text-sm font-medium text-ink">Quando o crescimento passa do limite de mudança</span>
        <span class="text-xs text-muted">
          Se o aumento necessário passa da "mudança máxima de orçamento" que você definiu em Limites de
          segurança, o agente pode perguntar como crescer, subir o orçamento até esse limite, ou criar uma
          cópia separada pra crescer além dele sem arriscar a que já funciona.
        </span>
        <div
          appToggleGroup
          ngpToggleGroupType="single"
          layout="segmented"
          [columns]="3"
          aria-labelledby="autonomy-scale"
          [ngpToggleGroupValue]="[scalePref()]"
          (ngpToggleGroupValueChange)="setScalePref($event)"
        >
          @for (p of SCALE_PREFS; track p.value) {
            <button appToggleGroupItem tone="accent" [ngpToggleGroupItemValue]="p.value">{{ p.label }}</button>
          }
        </div>
      </div>
    </section>
  `,
})
export class AgentAutonomy implements OnInit {
  private readonly api = inject(AnalysisApiService);

  readonly accountId = input.required<string>();
  /** emite o estado dirty p/ a save-bar única da página (§consistência de UX). */
  readonly dirtyChange = output<boolean>();

  protected readonly LEVELS = LEVELS;
  protected readonly SCALE_PREFS = SCALE_PREFS;
  protected readonly OPTIMIZE_TOOLS = OPTIMIZE_TOOLS;
  protected readonly CREATE_TOOLS = CREATE_TOOLS;
  protected readonly ACTION_AUTONOMY_OPTIONS = ACTION_AUTONOMY_OPTIONS;
  protected readonly agentName = AGENT_NAME;
  protected readonly SOURCES = [
    { key: 'playbook' as const, label: 'Regras do playbook', hint: 'Ações que saem das suas regras fixas.' },
    { key: 'llm' as const, label: `Análise do ${AGENT_NAME}`, hint: `O que o ${AGENT_NAME} sugere ao ler a conta.` },
  ];

  private readonly playbook = signal<Level>('suggest');
  private readonly llm = signal<Level>('suggest');
  protected readonly scalePref = signal<ScalePref>('ask');
  /** on/off das 6 tools (A3) — estado resolvido semeado do backend; edição grava bindings. */
  protected readonly toolBindings = signal<Partial<Record<ToolKey, boolean>>>({});
  /** autonomia por-ação (B) — override por tool-key; ausente/"" = herda a origem. */
  protected readonly byAction = signal<Partial<Record<ToolKey, Level>>>({});
  protected readonly showActions = signal(false);
  /** preservado no save (não editável aqui) — o replace do autonomyPolicy zeraria senão. */
  private readonly autoConfigViaChat = signal<boolean | undefined>(undefined);
  private readonly baseline = signal<string>('');

  protected level(key: 'playbook' | 'llm'): Level {
    return key === 'playbook' ? this.playbook() : this.llm();
  }
  protected setLevel(key: 'playbook' | 'llm', value: string | string[]): void {
    const v = (Array.isArray(value) ? value[0] : value) as Level;
    if (!v) return;
    (key === 'playbook' ? this.playbook : this.llm).set(v);
  }
  protected setScalePref(value: string | string[]): void {
    const v = (Array.isArray(value) ? value[0] : value) as ScalePref;
    if (!v) return;
    this.scalePref.set(v);
  }
  protected toolOn(key: ToolKey): boolean {
    return this.toolBindings()[key] ?? false;
  }
  protected setTool(key: ToolKey, on: boolean): void {
    this.toolBindings.set({ ...this.toolBindings(), [key]: on });
  }
  protected actionLevel(key: ToolKey): string {
    return this.byAction()[key] ?? '';
  }
  protected setActionLevel(key: ToolKey, value: string): void {
    const next = { ...this.byAction() };
    if (value === '') delete next[key];
    else next[key] = value as Level;
    this.byAction.set(next);
  }
  /** assinatura estável das 6 tools (on/off + override de autonomia) p/ o dirty. */
  private toolsSig(): string {
    return [...OPTIMIZE_TOOLS, ...CREATE_TOOLS]
      .map((t) => `${t.key}:${this.toolOn(t.key)}:${this.actionLevel(t.key)}`)
      .join(',');
  }

  protected readonly saving = signal(false);
  protected readonly loaded = signal(false);
  private readonly sig = computed(
    () => `${this.playbook()}|${this.llm()}|${this.scalePref()}|${this.toolsSig()}`,
  );
  /** público: a página lê p/ compor o dirty da save-bar única + decidir se salva. */
  readonly dirty = computed(() => this.sig() !== this.baseline());

  constructor() {
    // baseline = estado inicial → dirty começa false (Save só habilita após mudança).
    this.baseline.set(this.sig());
    effect(() => this.dirtyChange.emit(this.dirty()));
  }

  ngOnInit(): void {
    // secundária (a página-mãe já busca o agente): silenciosa p/ não duplicar toast.
    this.api.getAgent(this.accountId(), { silent: true }).subscribe({
      next: (a) => this.seed(a),
      error: () => {}, // load falhou → loaded fica false → Save desabilitado (não sobrescreve)
    });
  }

  private seed(a: AgentSummary): void {
    const pref = (a.autonomyPolicy.scaleAggressivePreference ?? 'ask') as ScalePref;
    this.playbook.set(a.autonomyPolicy.bySource.playbook as Level);
    this.llm.set(a.autonomyPolicy.bySource.llm as Level);
    this.scalePref.set(pref);
    this.toolBindings.set({ ...(a.toolBindings as Partial<Record<ToolKey, boolean>>) });
    this.byAction.set({ ...((a.autonomyPolicy.byAction ?? {}) as Partial<Record<ToolKey, Level>>) });
    this.autoConfigViaChat.set(a.autonomyPolicy.autoConfigViaChat);
    this.baseline.set(this.sig());
    this.loaded.set(true);
  }

  /** Salva a fatia (chamada pela save-bar única da página). No-op se não há mudança.
   *  Envia autoConfigViaChat junto (o backend REPLACE o autonomyPolicy — sem reenviar, zeraria). */
  async save(): Promise<boolean> {
    // gate em loaded(): se o seed falhou, não envia autonomyPolicy (o REPLACE do backend zeraria
    // autoConfigViaChat/scaleAggressivePreference que não foram semeados). Retorna se persistiu:
    // `true` = salvo ou nada a salvar; `false` = tinha mudança mas pulou (a página avisa, não mente).
    if (!this.dirty()) return true;
    if (!this.loaded()) return false;
    this.saving.set(true);
    try {
      const autoConfig = this.autoConfigViaChat();
      const a = await firstValueFrom(
        this.api.saveConfig(this.accountId(), {
          autonomyPolicy: {
            bySource: { playbook: this.playbook(), llm: this.llm() },
            scaleAggressivePreference: this.scalePref(),
            // byAction sempre presente (o backend REPLACE o autonomyPolicy) — {} = tudo herda.
            byAction: this.byAction(),
            ...(autoConfig !== undefined ? { autoConfigViaChat: autoConfig } : {}),
          },
          // grava as 6 explicitamente (backfill na edição) — bindings viram a fonte autoritativa.
          toolBindings: this.toolBindings(),
        }),
      );
      this.seed(a);
    } finally {
      this.saving.set(false);
    }
    return true;
  }
}
