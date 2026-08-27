import { ChangeDetectionStrategy, Component, type OnInit, inject, input, signal } from '@angular/core';
import { toast } from 'ngx-sonner';
import { NumberStepper, UiButton, UiSelectBox, type UiSelectOptionItem } from '@ui';
import { AnalysisApiService } from '@core/api/analysis-api.service';
import type { PlaybookRuleInput, PlaybookRuleOutput } from '@core/api/generated';

type Scope = PlaybookRuleInput['scope'];
type Metric = PlaybookRuleInput['metric'];
type Op = PlaybookRuleInput['op'];
type ActionType = 'pause_entity' | 'adjust_budget' | 'set_status';
type Status = 'active' | 'paused';

/** Linha editável (estado local) — mapeia 1:1 com uma regra do backend. */
interface RuleRow {
  /** chave estável do @for (NÃO muda ao editar) — evita recriar o DOM e perder foco. */
  key: string;
  id: string | null; // null = ainda não salva
  scope: Scope;
  metric: Metric;
  op: Op;
  // numéricos como STRING crua (o que o usuário digita) — evita o [value] brigar com
  // o parsing (decimais, sinal negativo). Convertidos só no envio (toInput).
  value: string;
  minSpend: string;
  action: ActionType;
  budgetChangePct: string;
  status: Status;
  enabled: boolean;
  priority: number;
  saving: boolean;
  /** assinatura do último estado persistido — base do dirty (salvar só se mudou). */
  savedSig: string;
}

const SCOPE_LABEL: Record<Scope, string> = { campaign: 'campanhas', adset: 'conjuntos', ad: 'anúncios' };
const METRIC_LABEL: Record<Metric, string> = {
  cpa: 'custo por conversão',
  roas: 'ROAS (retorno)',
  spend: 'gasto',
  cpc: 'custo por clique',
  cpm: 'custo por mil (CPM)',
  ctr: 'taxa de clique (CTR)',
  frequency: 'frequência',
};
const OP_LABEL: Record<Op, string> = { '>': 'maior que', '<': 'menor que', '>=': 'maior ou igual a', '<=': 'menor ou igual a', '==': 'igual a' };
const ACTION_LABEL: Record<ActionType, string> = { pause_entity: 'pausar', adjust_budget: 'ajustar orçamento', set_status: 'mudar status' };

const SCOPES: readonly Scope[] = ['campaign', 'adset', 'ad'];
const METRICS: readonly Metric[] = ['cpa', 'roas', 'spend', 'cpc', 'cpm', 'ctr', 'frequency'];
const OPS: readonly Op[] = ['>', '<', '>=', '<=', '=='];
const ACTIONS: readonly ActionType[] = ['pause_entity', 'adjust_budget', 'set_status'];

/** Opções (value+label) dos selects estilizados. */
const SCOPE_OPTIONS: readonly UiSelectOptionItem[] = SCOPES.map((s) => ({ value: s, label: SCOPE_LABEL[s] }));
const METRIC_OPTIONS: readonly UiSelectOptionItem[] = METRICS.map((m) => ({ value: m, label: METRIC_LABEL[m] }));
const OP_OPTIONS: readonly UiSelectOptionItem[] = OPS.map((o) => ({ value: o, label: OP_LABEL[o] }));
const ACTION_OPTIONS: readonly UiSelectOptionItem[] = ACTIONS.map((a) => ({ value: a, label: ACTION_LABEL[a] }));
const STATUS_OPTIONS: readonly UiSelectOptionItem[] = [
  { value: 'active', label: 'ativar' },
  { value: 'paused', label: 'pausar' },
];

/**
 * Editor de regras do playbook (Fatia 4 corte 2). Lista com CRUD: cada regra é uma
 * linha "SE [métrica op valor] (com gasto mínimo) ENTÃO [ação]", num nível. As ações
 * viram RECOMENDAÇÃO hoje; auto-aplicam quando o agente puder agir (5a). Componente
 * próprio (não incha a página); salva por regra (fora da save-bar de config).
 */
@Component({
  selector: 'app-agent-playbook',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [NumberStepper, UiButton, UiSelectBox],
  template: `
    <section class="flex flex-col gap-4 rounded-lg border border-line bg-panel p-5">
      <div class="flex items-start justify-between gap-3">
        <div class="flex flex-col gap-1">
          <span class="text-xs font-medium uppercase tracking-wide text-muted">Regras</span>
          <h2 class="font-brand text-base font-semibold text-ink">Regras automáticas</h2>
          <p class="text-xs text-muted">
            "Se acontecer X, faça Y." Cada regra vira uma recomendação na análise — o agente aplica sozinho
            quando você liberar a ação. Opcional.
          </p>
        </div>
        <button appButton variant="secondary" type="button" (click)="addRule()">+ Nova regra</button>
      </div>

      @if (loading()) {
        <p class="text-sm text-muted">Carregando regras…</p>
      } @else if (rows().length === 0) {
        <p class="rounded-md border border-dashed border-line px-4 py-6 text-center text-sm text-muted">
          Nenhuma regra ainda. Crie uma para o agente vigiar automaticamente — ex: "pausar anúncio que custa
          mais de {{ currency() }} 150 por conversão".
        </p>
      } @else {
        <ul class="flex flex-col gap-3">
          @for (r of rows(); track r.key; let i = $index) {
            <li class="flex flex-col gap-3 rounded-md border border-line px-4 py-3" [class.opacity-60]="!r.enabled">
              <div class="flex flex-wrap items-center gap-2 text-sm text-ink">
                <span class="text-muted">Em</span>
                <div class="w-36"><app-ui-select [options]="scopeOptions" [value]="r.scope" (valueChange)="setField(i, 'scope', $event)" /></div>
                <span class="text-muted">, se</span>
                <div class="w-48"><app-ui-select [options]="metricOptions" [value]="r.metric" (valueChange)="setField(i, 'metric', $event)" /></div>
                <div class="w-40"><app-ui-select [options]="opOptions" [value]="r.op" (valueChange)="setField(i, 'op', $event)" /></div>
                <input type="number" appNumberStepper step="0.01" class="w-28 rounded-md border border-line bg-app px-2 py-1.5 text-sm text-ink" placeholder="valor" [value]="r.value" (input)="setNum(i, 'value', $event)" />
              </div>

              <div class="flex flex-wrap items-center gap-2 text-sm text-ink">
                <span class="text-muted">com gasto mínimo de {{ currency() }}</span>
                <input type="number" appNumberStepper step="0.01" min="0" class="w-28 rounded-md border border-line bg-app px-2 py-1.5 text-sm text-ink" placeholder="opcional" [value]="r.minSpend" (input)="setNum(i, 'minSpend', $event)" />
                <span class="text-muted" title="evita disparar em entidade que mal rodou (número instável)">ⓘ</span>
              </div>

              <div class="flex flex-wrap items-center gap-2 text-sm text-ink">
                <span class="text-muted">então</span>
                <div class="w-48"><app-ui-select [options]="actionOptions" [value]="r.action" (valueChange)="setField(i, 'action', $event)" /></div>
                @if (r.action === 'adjust_budget') {
                  <input type="number" appNumberStepper step="1" class="w-24 rounded-md border border-line bg-app px-2 py-1.5 text-sm text-ink" placeholder="% (±)" [value]="r.budgetChangePct" (input)="setNum(i, 'budgetChangePct', $event)" />
                  <span class="text-muted">% (use negativo para reduzir)</span>
                }
                @if (r.action === 'set_status') {
                  <div class="w-32"><app-ui-select [options]="statusOptions" [value]="r.status" (valueChange)="setField(i, 'status', $event)" /></div>
                }
              </div>

              <div class="flex items-center justify-between gap-2 border-t border-line pt-2">
                <label class="flex items-center gap-2 text-xs text-muted">
                  <input type="checkbox" [checked]="r.enabled" (change)="toggleEnabled(i)" />
                  {{ r.enabled ? 'ativa' : 'desligada' }}
                </label>
                <div class="flex items-center gap-2">
                  <button type="button" class="text-xs text-muted hover:text-ink disabled:opacity-40" [disabled]="i === 0" (click)="move(i, -1)" title="subir prioridade">↑</button>
                  <button type="button" class="text-xs text-muted hover:text-ink disabled:opacity-40" [disabled]="i === rows().length - 1" (click)="move(i, 1)" title="descer prioridade">↓</button>
                  <button type="button" class="text-xs text-danger-strong hover:underline" (click)="remove(i)">excluir</button>
                  <button appButton variant="primary" type="button" [disabled]="r.saving || !canSave(r) || !dirty(r)" (click)="saveRow(i)">
                    {{ r.saving ? 'Salvando…' : r.id ? 'Salvar' : 'Criar' }}
                  </button>
                </div>
              </div>
            </li>
          }
        </ul>
        <p class="text-xs text-muted">
          Hoje as regras viram recomendação na análise. Quando você liberar o agente para agir, elas passam a
          ser aplicadas automaticamente.
        </p>
      }
    </section>
  `,
})
export class AgentPlaybook implements OnInit {
  private readonly api = inject(AnalysisApiService);
  readonly accountId = input.required<string>();
  /** moeda da conta (ISO) — rótulos de valor do playbook. Default até o pai passar. */
  readonly currency = input<string>('BRL');

  protected readonly scopeOptions = SCOPE_OPTIONS;
  protected readonly metricOptions = METRIC_OPTIONS;
  protected readonly opOptions = OP_OPTIONS;
  protected readonly actionOptions = ACTION_OPTIONS;
  protected readonly statusOptions = STATUS_OPTIONS;

  protected readonly loading = signal(true);
  protected readonly rows = signal<RuleRow[]>([]);

  ngOnInit(): void {
    // ngOnInit garante o input já resolvido (accountId é required).
    this.load();
  }

  private load(): void {
    this.api.listPlaybookRules(this.accountId()).subscribe({
      next: (out) => {
        this.rows.set(out.rules.map(toRow));
        this.loading.set(false);
      },
      error: () => this.loading.set(false),
    });
  }

  protected canSave(r: RuleRow): boolean {
    if (parseNum(r.value) === null) return false;
    if (r.action === 'adjust_budget' && parseNum(r.budgetChangePct) === null) return false;
    return true;
  }

  /** Mudou desde o último salvamento? (regra nova = savedSig vazio → sempre dirty). */
  protected dirty(r: RuleRow): boolean {
    return ruleSig(r) !== r.savedSig;
  }

  protected addRule(): void {
    const maxPriority = this.rows().reduce((m, r) => Math.max(m, r.priority), 0);
    this.rows.update((rs) => [blankRow(maxPriority + 1), ...rs]);
  }

  protected setField(i: number, field: 'scope' | 'metric' | 'op' | 'action' | 'status', value: string): void {
    this.patch(i, { [field]: value } as Partial<RuleRow>);
  }

  protected setNum(i: number, field: 'value' | 'minSpend' | 'budgetChangePct', e: Event): void {
    // guarda o texto cru (não parseia aqui) — parsing só no envio.
    this.patch(i, { [field]: (e.target as HTMLInputElement).value } as Partial<RuleRow>);
  }

  protected toggleEnabled(i: number): void {
    const row = this.rows()[i];
    if (!row) return;
    this.patch(i, { enabled: !row.enabled });
    if (row.id) this.saveRow(i); // persiste o liga/desliga na hora quando já existe
  }

  protected move(i: number, dir: -1 | 1): void {
    const rs = [...this.rows()];
    const j = i + dir;
    if (j < 0 || j >= rs.length) return;
    // troca as prioridades (ordem no backend = priority desc) e a posição na lista.
    const a = rs[i]!;
    const b = rs[j]!;
    const pa = a.priority;
    a.priority = b.priority;
    b.priority = pa;
    rs[i] = b;
    rs[j] = a;
    this.rows.set(rs);
    if (a.id) this.saveRow(rs.indexOf(a));
    if (b.id) this.saveRow(rs.indexOf(b));
  }

  protected saveRow(i: number): void {
    const row = this.rows()[i];
    if (!row || !this.canSave(row)) return;
    const key = row.key; // identidade estável (patch troca o objeto → não casar por ref)
    const input = toInput(row);
    const sig = ruleSig(row); // assinatura do que está sendo salvo → vira o novo baseline
    this.patch(i, { saving: true });
    const done = (saved: PlaybookRuleOutput): void => {
      this.patchByKey(key, { id: saved.id, saving: false, savedSig: sig });
    };
    const fail = (): void => this.patchByKey(key, { saving: false });
    if (row.id) {
      this.api.updatePlaybookRule(this.accountId(), row.id, input).subscribe({ next: done, error: fail });
    } else {
      this.api.createPlaybookRule(this.accountId(), input).subscribe({
        next: (saved) => {
          done(saved);
          toast.success('Regra criada');
        },
        error: fail,
      });
    }
  }

  protected remove(i: number): void {
    const row = this.rows()[i];
    if (!row) return;
    if (!row.id) {
      this.rows.update((rs) => rs.filter((r) => r !== row));
      return;
    }
    this.api.deletePlaybookRule(this.accountId(), row.id).subscribe({
      next: () => this.rows.update((rs) => rs.filter((r) => r !== row)),
      error: () => {},
    });
  }

  /** Atualiza a linha no índice i (imutável p/ o signal disparar). */
  private patch(i: number, partial: Partial<RuleRow>): void {
    this.rows.update((rs) => rs.map((r, idx) => (idx === i ? { ...r, ...partial } : r)));
  }

  /** Atualiza pela KEY estável (após async o índice/objeto podem ter mudado). */
  private patchByKey(key: string, partial: Partial<RuleRow>): void {
    this.rows.update((rs) => rs.map((r) => (r.key === key ? { ...r, ...partial } : r)));
  }
}

/** Contador p/ chaves estáveis de regras ainda não salvas (só client-side). */
let nextRowKey = 0;

function blankRow(priority: number): RuleRow {
  return {
    key: `new-${nextRowKey++}`,
    id: null,
    scope: 'ad',
    metric: 'cpa',
    op: '>',
    value: '',
    minSpend: '',
    action: 'pause_entity',
    budgetChangePct: '',
    status: 'paused',
    enabled: true,
    priority,
    saving: false,
    savedSig: '', // nova regra = sempre "dirty" (mas canSave barra a vazia)
  };
}

function toRow(r: PlaybookRuleOutput): RuleRow {
  const then = r.then;
  const row: RuleRow = {
    key: r.id, // id do servidor = chave estável
    id: r.id,
    scope: r.scope,
    metric: r.metric,
    op: r.op,
    value: String(r.value),
    minSpend: r.minSpend === null ? '' : String(r.minSpend),
    action: then.type,
    budgetChangePct: then.type === 'adjust_budget' ? String(then.budgetChangePct) : '',
    status: then.type === 'set_status' ? then.status : 'paused',
    enabled: r.enabled,
    priority: r.priority,
    saving: false,
    savedSig: '',
  };
  row.savedSig = ruleSig(row); // estado carregado = limpo (não dirty)
  return row;
}

/** Assinatura dos campos editáveis (base do dirty por regra). */
function ruleSig(r: RuleRow): string {
  return JSON.stringify([
    r.scope,
    r.metric,
    r.op,
    r.value.trim(),
    r.minSpend.trim(),
    r.action,
    r.budgetChangePct.trim(),
    r.status,
    r.enabled,
    r.priority,
  ]);
}

/** Texto → número finito, ou null quando vazio/ inválido. */
function parseNum(s: string): number | null {
  if (s.trim() === '') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function toInput(r: RuleRow): PlaybookRuleInput {
  const then: PlaybookRuleInput['then'] =
    r.action === 'adjust_budget'
      ? { type: 'adjust_budget', budgetChangePct: parseNum(r.budgetChangePct) ?? 0 }
      : r.action === 'set_status'
        ? { type: 'set_status', status: r.status }
        : { type: 'pause_entity' };
  const minSpend = parseNum(r.minSpend);
  return {
    scope: r.scope,
    metric: r.metric,
    op: r.op,
    value: parseNum(r.value) ?? 0,
    ...(minSpend !== null ? { minSpend } : {}),
    then,
    enabled: r.enabled,
    priority: r.priority,
  };
}
