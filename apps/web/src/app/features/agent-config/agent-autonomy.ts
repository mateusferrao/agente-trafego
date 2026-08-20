import { ChangeDetectionStrategy, Component, type OnInit, inject, input, signal, computed } from '@angular/core';
import { toast } from 'ngx-sonner';
import { UiButton, UiToggleGroup, UiToggleGroupItem } from '@ui';
import { AnalysisApiService } from '@core/api/analysis-api.service';
import type { AgentSummary } from '@core/api/generated';

type Level = 'notify' | 'suggest' | 'act_safe' | 'act_full';

const LEVELS: readonly { value: Level; label: string }[] = [
  { value: 'notify', label: 'só avisa' },
  { value: 'suggest', label: 'sugere + OK' },
  { value: 'act_safe', label: 'age no seguro' },
  { value: 'act_full', label: 'age sozinho' },
];

/**
 * Autonomia por origem (5a): quanto o agente pode agir sozinho a partir do playbook
 * (regras) × do LLM (análise). Só MORDE quando a escrita estiver ligada — no read-only
 * configura e persiste, mas o agente não age. Componente próprio (salva sua fatia).
 */
@Component({
  selector: 'app-agent-autonomy',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [UiButton, UiToggleGroup, UiToggleGroupItem],
  template: `
    <section class="flex flex-col gap-4 rounded-lg border border-line bg-panel p-5">
      <div class="flex items-start justify-between gap-3">
        <div>
          <h2 class="font-brand text-base font-semibold text-ink">Até onde o agente pode ir</h2>
          <p class="mt-1 text-xs text-muted">
            Quanto ele age sozinho, por origem. Só vale quando a escrita estiver ligada — por enquanto
            configura e guarda; agir de verdade vem depois.
          </p>
        </div>
        <button appButton size="sm" [disabled]="saving() || !dirty()" (click)="save()">
          {{ saving() ? 'Salvando…' : 'Salvar' }}
        </button>
      </div>

      @for (src of SOURCES; track src.key) {
        <div class="flex flex-col gap-2">
          <span class="text-sm font-medium text-ink">{{ src.label }}</span>
          <span class="text-xs text-muted">{{ src.hint }}</span>
          <div
            appToggleGroup
            ngpToggleGroupType="single"
            layout="segmented"
            [columns]="4"
            [ngpToggleGroupValue]="[level(src.key)]"
            (ngpToggleGroupValueChange)="setLevel(src.key, $event)"
          >
            @for (l of LEVELS; track l.value) {
              <button appToggleGroupItem tone="accent" [ngpToggleGroupItemValue]="l.value">{{ l.label }}</button>
            }
          </div>
        </div>
      }
    </section>
  `,
})
export class AgentAutonomy implements OnInit {
  private readonly api = inject(AnalysisApiService);

  readonly accountId = input.required<string>();

  protected readonly LEVELS = LEVELS;
  protected readonly SOURCES = [
    { key: 'playbook' as const, label: 'Regras do playbook', hint: 'Ações que saem das suas regras determinísticas.' },
    { key: 'llm' as const, label: 'Análise do agente (IA)', hint: 'Ações que a IA propõe a partir da leitura da conta.' },
  ];

  private readonly playbook = signal<Level>('suggest');
  private readonly llm = signal<Level>('suggest');
  private readonly baseline = signal<string>('');

  protected level(key: 'playbook' | 'llm'): Level {
    return key === 'playbook' ? this.playbook() : this.llm();
  }
  protected setLevel(key: 'playbook' | 'llm', value: string | string[]): void {
    const v = (Array.isArray(value) ? value[0] : value) as Level;
    if (!v) return;
    (key === 'playbook' ? this.playbook : this.llm).set(v);
  }

  protected readonly saving = signal(false);
  private readonly sig = computed(() => `${this.playbook()}|${this.llm()}`);
  protected readonly dirty = computed(() => this.sig() !== this.baseline());

  ngOnInit(): void {
    this.api.getAgent(this.accountId()).subscribe({
      next: (a) => this.seed(a),
      error: () => {},
    });
  }

  private seed(a: AgentSummary): void {
    this.playbook.set(a.autonomyPolicy.bySource.playbook as Level);
    this.llm.set(a.autonomyPolicy.bySource.llm as Level);
    this.baseline.set(`${a.autonomyPolicy.bySource.playbook}|${a.autonomyPolicy.bySource.llm}`);
  }

  protected save(): void {
    if (!this.dirty()) return;
    this.saving.set(true);
    this.api
      .saveConfig(this.accountId(), { autonomyPolicy: { bySource: { playbook: this.playbook(), llm: this.llm() } } })
      .subscribe({
        next: (a) => {
          this.seed(a);
          this.saving.set(false);
          toast.success('autonomia salva');
        },
        error: () => this.saving.set(false),
      });
  }
}
