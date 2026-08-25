import { ChangeDetectionStrategy, Component, type OnInit, inject, input, signal, computed } from '@angular/core';
import { toast } from 'ngx-sonner';
import { UiButton, UiToggleGroup, UiToggleGroupItem, UiConfirmDialogService } from '@ui';
import { AnalysisApiService } from '@core/api/analysis-api.service';
import type { AgentConfigInput, AgentSummary, ArchetypeCatalogOutput } from '@core/api/generated';

type PostureAxis = ArchetypeCatalogOutput['postureAxes'][number];
type ExperienceOpt = ArchetypeCatalogOutput['experienceLevels'][number];
type AxisKey = 'directiveness' | 'volume' | 'didacticDepth';

/**
 * Postura de comunicação (voz): COMO o agente fala com o dono — diretividade, volume de
 * sugestões e profundidade didática. NÃO é o mesmo que autonomia (se ele APLICA mudanças).
 * Lidera pelo PRESET de experiência (atalho, com modal de preview); os 3 eixos ficam sob
 * "personalizar" (divulgação progressiva). Componente próprio (salva sua fatia).
 */
@Component({
  selector: 'app-agent-posture',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [UiButton, UiToggleGroup, UiToggleGroupItem],
  template: `
    <section class="flex flex-col gap-4 rounded-lg border border-line bg-panel p-5">
      <div>
        <h2 class="font-brand text-base font-semibold text-ink">Como o agente se comunica com você</h2>
        <p class="mt-1 text-xs text-muted">
          Isto muda como o agente <span class="text-ink">fala</span> — não se ele aplica mudanças na conta
          (isso é a autonomia).
        </p>
      </div>

      <!-- Perfil (preset): controle primário. Clicar mostra o preview e confirma. -->
      <div class="flex flex-col gap-2">
        <span class="text-sm font-medium text-ink">Perfil de comunicação</span>
        <span class="text-xs text-muted">{{ profileLine() }}</span>
        <div class="flex flex-wrap gap-2">
          @for (p of presets(); track p.level) {
            <button
              appButton
              size="sm"
              [variant]="experienceLevel() === p.level ? 'primary' : 'secondary'"
              [disabled]="saving() || !loaded()"
              [title]="p.whenToUse"
              (click)="pickPreset(p)"
            >
              {{ p.label }}
            </button>
          }
        </div>
      </div>

      <!-- Ajuste fino dos 3 eixos (divulgação progressiva). -->
      <details class="rounded-md border border-line/60">
        <summary class="cursor-pointer px-3 py-2 text-sm text-ink">Personalizar cada eixo</summary>
        <div class="flex flex-col gap-4 px-3 pb-3 pt-1">
          @for (axis of axesCatalog(); track axis.key) {
            <div class="flex flex-col gap-2">
              <span [id]="'posture-' + axis.key" class="text-sm font-medium text-ink">{{ axis.label }}</span>
              <span class="text-xs text-muted">{{ axis.help }}</span>
              <div
                appToggleGroup
                ngpToggleGroupType="single"
                layout="segmented"
                [columns]="3"
                [attr.aria-labelledby]="'posture-' + axis.key"
                [ngpToggleGroupValue]="[axisValue(axis.key)]"
                (ngpToggleGroupValueChange)="setAxis(axis.key, $event)"
              >
                @for (l of axis.levels; track l.level) {
                  <button appToggleGroupItem tone="accent" [ngpToggleGroupItemValue]="l.level" [title]="l.description">
                    {{ l.label }}
                  </button>
                }
              </div>
            </div>
          }
          <div class="flex justify-end">
            <button appButton size="sm" [disabled]="saving() || !dirty() || !loaded()" (click)="save()">
              {{ saving() ? 'Salvando…' : 'Salvar ajustes' }}
            </button>
          </div>
        </div>
      </details>
    </section>
  `,
})
export class AgentPosture implements OnInit {
  private readonly api = inject(AnalysisApiService);
  private readonly confirmDialog = inject(UiConfirmDialogService);

  readonly accountId = input.required<string>();

  protected readonly axesCatalog = signal<PostureAxis[]>([]);
  protected readonly presets = signal<ExperienceOpt[]>([]);

  private readonly directiveness = signal<string>('consultative');
  private readonly volume = signal<string>('balanced');
  private readonly didacticDepth = signal<string>('explanatory');
  private readonly experienceLevel = signal<string | null>(null);
  private readonly isCustom = signal(false);
  private readonly baseline = signal('');

  protected readonly saving = signal(false);
  protected readonly loaded = signal(false);
  private readonly sig = computed(() => `${this.directiveness()}|${this.volume()}|${this.didacticDepth()}`);
  protected readonly dirty = computed(() => this.sig() !== this.baseline());

  /** Frase do perfil atual (preset + "com ajustes" quando os eixos divergem). */
  protected readonly profileLine = computed(() => {
    const lvl = this.experienceLevel();
    if (!lvl) return 'Definido pelo arquétipo. Escolha um perfil ou ajuste cada eixo.';
    const p = this.presets().find((x) => x.level === lvl);
    const name = p?.label ?? lvl;
    return this.isCustom() ? `Perfil ${name} (com ajustes)` : `Perfil ${name}`;
  });

  constructor() {
    this.baseline.set(this.sig());
  }

  ngOnInit(): void {
    // catálogo (eixos + presets) — servido junto dos arquétipos.
    this.api.archetypes().subscribe({
      next: (out) => {
        this.axesCatalog.set(out.postureAxes as PostureAxis[]);
        this.presets.set(out.experienceLevels as ExperienceOpt[]);
      },
      error: () => {},
    });
    // estado atual do agente (silencioso — a página-mãe já busca).
    this.api.getAgent(this.accountId(), { silent: true }).subscribe({
      next: (a) => this.seed(a),
      error: () => {},
    });
  }

  protected axisValue(key: AxisKey): string {
    return key === 'directiveness' ? this.directiveness() : key === 'volume' ? this.volume() : this.didacticDepth();
  }
  protected setAxis(key: AxisKey, value: string | string[]): void {
    const v = Array.isArray(value) ? value[0] : value;
    if (!v) return;
    (key === 'directiveness' ? this.directiveness : key === 'volume' ? this.volume : this.didacticDepth).set(v);
  }

  private levelLabel(key: AxisKey, level: string): string {
    const axis = this.axesCatalog().find((a) => a.key === key);
    return axis?.levels.find((l) => l.level === level)?.label ?? level;
  }

  /** Escolher um perfil: modal de preview do que vai mudar → aplica (semeia os 3 eixos). */
  protected async pickPreset(p: ExperienceOpt): Promise<void> {
    if (this.saving()) return;
    const description =
      `Isto vai ajustar como o agente fala: ` +
      `diretividade → ${this.levelLabel('directiveness', p.axes.directiveness)}, ` +
      `volume → ${this.levelLabel('volume', p.axes.volume)}, ` +
      `profundidade → ${this.levelLabel('didacticDepth', p.axes.didacticDepth)}. ` +
      `Você pode ajustar cada eixo depois.`;
    const ok = await this.confirmDialog.confirm({
      title: `Usar o perfil "${p.label}"?`,
      description,
      confirmLabel: 'Usar perfil',
      cancelLabel: 'Cancelar',
      tone: 'info',
    });
    if (!ok) return;
    this.saving.set(true);
    this.api.saveConfig(this.accountId(), { posture: { experienceLevel: p.level } }).subscribe({
      next: (a) => {
        this.seed(a);
        this.saving.set(false);
        toast.success('Perfil de comunicação salvo');
      },
      error: () => this.saving.set(false),
    });
  }

  protected save(): void {
    if (!this.dirty()) return;
    this.saving.set(true);
    // os valores vêm do catálogo (level: string), mas o contrato tipa os enums — cast seguro.
    const posture = {
      directiveness: this.directiveness(),
      volume: this.volume(),
      didacticDepth: this.didacticDepth(),
    } as AgentConfigInput['posture'];
    this.api
      .saveConfig(this.accountId(), { posture })
      .subscribe({
        next: (a) => {
          this.seed(a);
          this.saving.set(false);
          toast.success('Comunicação salva');
        },
        error: () => this.saving.set(false),
      });
  }

  private seed(a: AgentSummary): void {
    this.directiveness.set(a.posture.directiveness);
    this.volume.set(a.posture.volume);
    this.didacticDepth.set(a.posture.didacticDepth);
    this.experienceLevel.set(a.posture.experienceLevel);
    this.isCustom.set(a.postureIsCustom);
    this.baseline.set(`${a.posture.directiveness}|${a.posture.volume}|${a.posture.didacticDepth}`);
    this.loaded.set(true);
  }
}
