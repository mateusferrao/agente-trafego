import { ChangeDetectionStrategy, Component, type OnInit, effect, inject, input, output, signal, computed } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { UiToggleGroup, UiToggleGroupItem } from '@ui';
import { AnalysisApiService } from '@core/api/analysis-api.service';
import type { AgentSummary } from '@core/api/generated';

type Level = 'notify' | 'suggest' | 'act_safe' | 'act_full';
type ScalePref = 'ask' | 'raise' | 'duplicate';

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
  imports: [UiToggleGroup, UiToggleGroupItem],
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

      <div class="flex flex-col gap-2 border-t border-line pt-4">
        <span id="autonomy-scale" class="text-sm font-medium text-ink">Escalar um vencedor além do limite seguro</span>
        <span class="text-xs text-muted">
          Quando o aumento pedido é grande, o agente pode perguntar como crescer, sempre subir o orçamento
          no limite seguro, ou sempre criar uma cópia separada.
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
  protected readonly SOURCES = [
    { key: 'playbook' as const, label: 'Regras do playbook', hint: 'Ações que saem das suas regras determinísticas.' },
    { key: 'llm' as const, label: 'Análise do agente (IA)', hint: 'Ações que a IA propõe a partir da leitura da conta.' },
  ];

  private readonly playbook = signal<Level>('suggest');
  private readonly llm = signal<Level>('suggest');
  protected readonly scalePref = signal<ScalePref>('ask');
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

  protected readonly saving = signal(false);
  protected readonly loaded = signal(false);
  private readonly sig = computed(() => `${this.playbook()}|${this.llm()}|${this.scalePref()}`);
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
    this.autoConfigViaChat.set(a.autonomyPolicy.autoConfigViaChat);
    this.baseline.set(`${a.autonomyPolicy.bySource.playbook}|${a.autonomyPolicy.bySource.llm}|${pref}`);
    this.loaded.set(true);
  }

  /** Salva a fatia (chamada pela save-bar única da página). No-op se não há mudança.
   *  Envia autoConfigViaChat junto (o backend REPLACE o autonomyPolicy — sem reenviar, zeraria). */
  async save(): Promise<void> {
    if (!this.dirty()) return;
    this.saving.set(true);
    try {
      const autoConfig = this.autoConfigViaChat();
      const a = await firstValueFrom(
        this.api.saveConfig(this.accountId(), {
          autonomyPolicy: {
            bySource: { playbook: this.playbook(), llm: this.llm() },
            scaleAggressivePreference: this.scalePref(),
            ...(autoConfig !== undefined ? { autoConfigViaChat: autoConfig } : {}),
          },
        }),
      );
      this.seed(a);
    } finally {
      this.saving.set(false);
    }
  }
}
