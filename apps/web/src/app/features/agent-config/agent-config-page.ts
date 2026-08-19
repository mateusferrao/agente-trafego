import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { toast } from 'ngx-sonner';
import { UiButton, UiPageHeader, UiSpinner } from '@ui';
import { AccountsApiService } from '@core/api/accounts-api.service';
import { AnalysisApiService } from '@core/api/analysis-api.service';
import type { AgentConfigInput, AvailableConversionsOutput } from '@core/api/generated';

type Conversion = AvailableConversionsOutput['conversions'][number];

/** Rótulos amigáveis PT-BR da taxonomia neutra (custom cai no nome real do backend). */
const CONVERSION_LABEL: Record<string, string> = {
  purchase: 'Venda',
  lead: 'Lead',
  registration: 'Cadastro',
  initiate_checkout: 'Início de checkout',
  add_to_cart: 'Adição ao carrinho',
  view_content: 'Visualização de conteúdo',
  add_payment_info: 'Adição de pagamento',
  search: 'Busca',
  contact: 'Contato',
  subscribe: 'Assinatura',
  start_trial: 'Início de teste',
  submit_application: 'Envio de inscrição',
  messaging_started: 'Conversa iniciada',
  app_install: 'Instalação de app',
  custom: 'Conversão personalizada',
};

/** Uma opção do select de conversão de negócio (chave + rótulo + anotação de dado). */
interface ConversionOption {
  readonly key: string; // `${goal}:${customConversionId}` ("" = customConversionId vazio)
  readonly goal: string;
  readonly customConversionId: string;
  readonly label: string;
  readonly count: number;
}

/** Snapshot do formulário — base do dirty-tracking (salvar só quando muda algo). */
interface FormState {
  readonly targetCPA: number | null;
  readonly targetROAS: number | null;
  readonly conversionKey: string; // "" = sem conversão de negócio (usa o objetivo da entidade)
  readonly businessContext: string;
  readonly guidance: string;
}

/**
 * Superfície "Agente" (Fatia 4 corte 1): meta + conversão de NEGÓCIO + personalização
 * por texto (contexto + orientações). Seccionada, semeada pela config atual do agente.
 * Autonomia/guardrails/regras entram no próximo corte, na MESMA superfície.
 * Segue docs/DESIGN.md (sentence case, erro amigável, próximo passo, save bar dirty).
 */
@Component({
  selector: 'app-agent-config-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, UiButton, UiPageHeader, UiSpinner],
  template: `
    <div class="flex flex-col gap-8">
      <div class="flex flex-col gap-1">
        <a [routerLink]="['/accounts', accountId]" class="text-xs text-muted hover:text-ink">← {{ accountName() }}</a>
        <app-ui-page-header title="Configurar agente" subtitle="Ensine o agente sobre o seu negócio e como ele deve recomendar." />
      </div>

      @if (loading()) {
        <div class="flex items-center justify-center gap-3 rounded-lg border border-line bg-panel p-10 text-sm text-muted">
          <app-ui-spinner [size]="20" [stroke]="2" aria-hidden="true" />
          Carregando…
        </div>
      } @else {
        <!-- Objetivo: meta + conversão de negócio (o que mais direciona a análise → topo) -->
        <section class="flex flex-col gap-4 rounded-lg border border-line bg-panel p-5">
          <div class="flex flex-col gap-1">
            <span class="text-xs font-medium uppercase tracking-wide text-muted">Objetivo</span>
            <h2 class="font-brand text-base font-semibold text-ink">Meta e resultado</h2>
            <p class="text-xs text-muted">
              Definir a meta faz o agente comparar o desempenho e priorizar melhor. Tudo opcional.
            </p>
          </div>

          <div class="flex flex-col gap-2" role="radiogroup" aria-label="Conversão de negócio">
            <span class="text-xs text-muted">O que conta como resultado pro seu negócio?</span>

            @if (showConversionScroll()) {
              <input
                type="text"
                class="w-full rounded-md border border-line bg-app px-3 py-2 text-sm text-ink"
                placeholder="Buscar conversão…"
                [value]="conversionQuery()"
                (input)="onConversionQuery($event)"
              />
            }

            <!-- Padrão fica sempre visível (fora do scroll/busca) -->
            <button
              type="button"
              role="radio"
              [attr.aria-checked]="conversionKey() === ''"
              (click)="setConversion('')"
              class="flex items-center justify-between gap-3 rounded-md border px-4 py-3 text-left transition hover:border-accent/40"
              [class.border-accent]="conversionKey() === ''"
              [class.bg-accent-soft]="conversionKey() === ''"
              [class.border-line]="conversionKey() !== ''"
            >
              <span class="flex min-w-0 flex-col gap-0.5">
                <span class="text-sm font-semibold text-ink">Detectar pelo que a campanha otimiza</span>
                <span class="text-xs text-muted">padrão — usa o objetivo de cada campanha</span>
              </span>
              <span
                class="size-4 shrink-0 rounded-full border transition"
                [class.border-accent]="conversionKey() === ''"
                [class.bg-accent]="conversionKey() === ''"
                [class.border-line]="conversionKey() !== ''"
                aria-hidden="true"
              ></span>
            </button>

            <!-- Lista com scroll próprio a partir de 4 conversões -->
            <div
              class="flex flex-col gap-2"
              [class.max-h-72]="showConversionScroll()"
              [class.overflow-y-auto]="showConversionScroll()"
            >
              @for (opt of filteredConversionOptions(); track opt.key) {
                <button
                  type="button"
                  role="radio"
                  [attr.aria-checked]="conversionKey() === opt.key"
                  (click)="setConversion(opt.key)"
                  class="flex items-center justify-between gap-3 rounded-md border px-4 py-3 text-left transition hover:border-accent/40"
                  [class.border-accent]="conversionKey() === opt.key"
                  [class.bg-accent-soft]="conversionKey() === opt.key"
                  [class.border-line]="conversionKey() !== opt.key"
                >
                  <span class="flex min-w-0 flex-col gap-0.5">
                    <span class="truncate text-sm font-semibold text-ink">{{ opt.label }}</span>
                    <span class="text-xs" [class.text-muted]="opt.count > 0" [class.text-warning-strong]="opt.count === 0">
                      {{ opt.count > 0 ? opt.count + ' eventos nos últimos 30 dias' : 'sem eventos nos últimos 30 dias' }}
                    </span>
                  </span>
                  <span
                    class="size-4 shrink-0 rounded-full border transition"
                    [class.border-accent]="conversionKey() === opt.key"
                    [class.bg-accent]="conversionKey() === opt.key"
                    [class.border-line]="conversionKey() !== opt.key"
                    aria-hidden="true"
                  ></span>
                </button>
              } @empty {
                <p class="px-1 py-2 text-xs text-muted">Nenhuma conversão encontrada.</p>
              }
            </div>
            <p class="text-xs text-muted">
              Usamos isso pra medir seu custo por resultado. Se uma campanha otimiza outra coisa, o agente é
              honesto: mostra o custo daquele objetivo como referência, sem tratar como venda.
            </p>
          </div>

          <div class="flex flex-wrap items-end gap-4">
            <label class="flex flex-col gap-1 text-xs text-muted">
              Custo por resultado alvo (R$)
              <input
                type="number"
                min="0"
                step="0.01"
                class="w-40 rounded-md border border-line bg-app px-3 py-2 text-sm text-ink"
                [value]="targetCPA() ?? ''"
                (input)="onCpa($event)"
              />
            </label>
            <label class="flex flex-col gap-1 text-xs text-muted">
              Retorno sobre investimento alvo (ROAS)
              <input
                type="number"
                min="0"
                step="0.1"
                class="w-40 rounded-md border border-line bg-app px-3 py-2 text-sm text-ink"
                [value]="targetROAS() ?? ''"
                (input)="onRoas($event)"
              />
            </label>
          </div>
        </section>

        <!-- Contexto do negócio (fatos) -->
        <section class="flex flex-col gap-3 rounded-lg border border-line bg-panel p-5">
          <div class="flex flex-col gap-1">
            <span class="text-xs font-medium uppercase tracking-wide text-muted">Sobre o negócio</span>
            <h2 class="font-brand text-base font-semibold text-ink">Contexto do negócio</h2>
            <p class="text-xs text-muted">
              Fatos que ajudam o agente a entender sua realidade — público, oferta, momento de lançamento, ticket. Opcional.
            </p>
          </div>
          <textarea
            rows="4"
            maxlength="2000"
            class="w-full rounded-md border border-line bg-app px-3 py-2 text-sm text-ink"
            placeholder="Ex: estou em lançamento até 30/08, público de médicos, ticket R$2 mil. Priorizo lead qualificado."
            [value]="businessContext()"
            (input)="onBusinessContext($event)"
          ></textarea>
        </section>

        <!-- Orientações (comportamento) -->
        <section class="flex flex-col gap-3 rounded-lg border border-line bg-panel p-5">
          <div class="flex flex-col gap-1">
            <span class="text-xs font-medium uppercase tracking-wide text-muted">Como agir</span>
            <h2 class="font-brand text-base font-semibold text-ink">Orientações ao agente</h2>
            <p class="text-xs text-muted">
              Como você quer que ele analise e recomende — prioridades, o que evitar, tom. Opcional.
            </p>
          </div>
          <textarea
            rows="4"
            maxlength="2000"
            class="w-full rounded-md border border-line bg-app px-3 py-2 text-sm text-ink"
            placeholder="Ex: não sugira pausar nos 3 primeiros dias de uma campanha. Priorize escalar o que já bate a meta."
            [value]="guidance()"
            (input)="onGuidance($event)"
          ></textarea>
        </section>

        @if (justSaved() && !dirty()) {
          <p class="rounded-lg border border-line bg-soft p-4 text-sm text-ink">
            Configuração salva. Para ver o efeito agora,
            <a [routerLink]="['/accounts', accountId]" class="underline">rode "Analisar agora"</a>
            — senão a próxima análise automática já usa a nova configuração.
          </p>
        }

        <!-- Save bar (dirty) — flutua no rodapé pra não obrigar a rolar até o fim -->
        <div class="sticky bottom-0 z-10 flex items-center justify-between gap-3 rounded-lg border border-line bg-panel p-4 shadow-card">
          <span class="text-sm" [class.text-muted]="!dirty()" [class.text-ink]="dirty()">
            {{ dirty() ? 'Alterações não salvas' : 'Configuração salva' }}
          </span>
          <button appButton variant="primary" type="button" [disabled]="!dirty() || saving()" (click)="save()">
            {{ saving() ? 'Salvando…' : 'Salvar configuração' }}
          </button>
        </div>
      }
    </div>
  `,
})
export class AgentConfigPage {
  private readonly route = inject(ActivatedRoute);
  private readonly accountsApi = inject(AccountsApiService);
  private readonly analysisApi = inject(AnalysisApiService);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly accountId = this.route.snapshot.paramMap.get('id') ?? '';
  private destroyed = false;

  protected readonly loading = signal(true);
  protected readonly saving = signal(false);
  protected readonly justSaved = signal(false);
  protected readonly accountName = signal('Conta');

  // form
  protected readonly businessContext = signal('');
  protected readonly guidance = signal('');
  protected readonly targetCPA = signal<number | null>(null);
  protected readonly targetROAS = signal<number | null>(null);
  protected readonly conversionKey = signal(''); // `${goal}:${cid}` ("" = sem conversão de negócio)

  private readonly available = signal<Conversion[]>([]);
  protected readonly conversionQuery = signal('');
  /** snapshot inicial (config carregada) — dirty = form atual difere daqui. */
  private readonly initial = signal<FormState>(EMPTY_FORM);

  protected readonly dirty = computed(() => !sameForm(this.current(), this.initial()));

  /** Opções do select: conversões que a conta reporta + a atual (se fora da lista). */
  protected readonly conversionOptions = computed<ConversionOption[]>(() => {
    const opts = this.available().map(toOption);
    const key = this.conversionKey();
    if (key && !opts.some((o) => o.key === key)) opts.unshift(syntheticOption(key));
    return opts;
  });

  /** Busca + scroll próprio a partir de 4 conversões (com 1-3 a lista curta basta). */
  protected readonly showConversionScroll = computed(
    () => this.conversionOptions().length >= CONVERSION_SCROLL_THRESHOLD,
  );

  /** Opções filtradas pela busca (por rótulo). */
  protected readonly filteredConversionOptions = computed<ConversionOption[]>(() => {
    const q = this.conversionQuery().trim().toLowerCase();
    const opts = this.conversionOptions();
    return q ? opts.filter((o) => o.label.toLowerCase().includes(q)) : opts;
  });

  constructor() {
    this.destroyRef.onDestroy(() => {
      this.destroyed = true;
    });
    this.load();
  }

  protected setConversion(key: string): void {
    this.conversionKey.set(key);
  }

  protected onConversionQuery(e: Event): void {
    this.conversionQuery.set((e.target as HTMLInputElement).value);
  }

  protected onBusinessContext(e: Event): void {
    this.businessContext.set((e.target as HTMLTextAreaElement).value);
  }
  protected onGuidance(e: Event): void {
    this.guidance.set((e.target as HTMLTextAreaElement).value);
  }
  protected onCpa(e: Event): void {
    this.targetCPA.set(parsePositive(e));
  }
  protected onRoas(e: Event): void {
    this.targetROAS.set(parsePositive(e));
  }
  protected onConversion(e: Event): void {
    this.conversionKey.set((e.target as HTMLSelectElement).value);
  }

  protected save(): void {
    this.saving.set(true);
    this.analysisApi.saveConfig(this.accountId, this.buildInput()).subscribe({
      next: () => {
        this.initial.set(this.current()); // limpa o dirty
        this.saving.set(false);
        this.justSaved.set(true);
        toast.success('Configuração salva');
      },
      // erro amigável já vem do interceptor global.
      error: () => this.saving.set(false),
    });
  }

  private current(): FormState {
    return {
      targetCPA: this.targetCPA(),
      targetROAS: this.targetROAS(),
      conversionKey: this.conversionKey(),
      businessContext: this.businessContext(),
      guidance: this.guidance(),
    };
  }

  private buildInput(): AgentConfigInput {
    const { goal, customConversionId } = splitKey(this.conversionKey());
    // goal vem das opções (derivadas do server) → é um ConversionGoal válido; o cast
    // referencia o próprio tipo gerado (sem depender do nome do enum do kubb).
    const conversionGoal = goal as NonNullable<AgentConfigInput['goals']>['conversionGoal'];
    const goals = {
      ...(this.targetCPA() !== null ? { targetCPA: this.targetCPA()! } : {}),
      ...(this.targetROAS() !== null ? { targetROAS: this.targetROAS()! } : {}),
      ...(goal ? { conversionGoal } : {}),
      ...(goal === 'custom' && customConversionId ? { customConversionId } : {}),
    };
    return { goals, businessContext: this.businessContext(), guidance: this.guidance() };
  }

  private load(): void {
    this.accountsApi.list().subscribe({
      next: (rows) => {
        const acc = rows.find((r) => r.id === this.accountId);
        if (acc) this.accountName.set(acc.name ?? acc.adAccountId);
      },
      error: () => {},
    });
    // conversões disponíveis (anotação do select) — silenciosa, pode vir vazia.
    this.analysisApi.availableConversions(this.accountId).subscribe({
      next: (out) => this.available.set(out.conversions),
      error: () => this.available.set([]),
    });
    this.analysisApi.getAgent(this.accountId).subscribe({
      next: (agent) => {
        this.businessContext.set(agent.businessContext ?? '');
        this.guidance.set(agent.guidance ?? '');
        this.targetCPA.set(agent.goals.targetCPA ?? null);
        this.targetROAS.set(agent.goals.targetROAS ?? null);
        this.conversionKey.set(
          agent.goals.conversionGoal
            ? keyOf(agent.goals.conversionGoal, agent.goals.customConversionId ?? '')
            : '',
        );
        this.initial.set(this.current()); // baseline p/ o dirty
        this.loading.set(false);
      },
      error: () => {
        if (!this.destroyed) this.loading.set(false);
      },
    });
  }
}

/** A partir desta quantidade de conversões, a lista ganha scroll próprio. */
const CONVERSION_SCROLL_THRESHOLD = 4;

const EMPTY_FORM: FormState = {
  targetCPA: null,
  targetROAS: null,
  conversionKey: '',
  businessContext: '',
  guidance: '',
};

function sameForm(a: FormState, b: FormState): boolean {
  return (
    a.targetCPA === b.targetCPA &&
    a.targetROAS === b.targetROAS &&
    a.conversionKey === b.conversionKey &&
    a.businessContext.trim() === b.businessContext.trim() &&
    a.guidance.trim() === b.guidance.trim()
  );
}

function keyOf(goal: string, customConversionId: string): string {
  return `${goal}:${customConversionId}`;
}

function splitKey(key: string): { goal: string; customConversionId: string } {
  if (!key) return { goal: '', customConversionId: '' };
  const idx = key.indexOf(':');
  return idx < 0
    ? { goal: key, customConversionId: '' }
    : { goal: key.slice(0, idx), customConversionId: key.slice(idx + 1) };
}

function toOption(c: Conversion): ConversionOption {
  const customConversionId = c.customConversionId ?? '';
  return {
    key: keyOf(c.goal, customConversionId),
    goal: c.goal,
    customConversionId,
    label: c.label ?? CONVERSION_LABEL[c.goal] ?? c.goal,
    count: c.count,
  };
}

/** Opção sintética p/ a conversão já salva que não apareceu na janela recente. */
function syntheticOption(key: string): ConversionOption {
  const { goal, customConversionId } = splitKey(key);
  return {
    key,
    goal,
    customConversionId,
    label: CONVERSION_LABEL[goal] ?? goal,
    count: 0,
  };
}

function parsePositive(event: Event): number | null {
  const value = (event.target as HTMLInputElement).value;
  if (value.trim() === '') return null;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}
