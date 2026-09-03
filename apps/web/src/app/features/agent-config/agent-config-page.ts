import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ViewChild,
  type WritableSignal,
  computed,
  inject,
  signal,
} from '@angular/core';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { toast } from 'ngx-sonner';
import { NumberStepper, UiButton, UiConfirmDialogService, UiPageHeader, UiSelectBox, UiSpinner, type UiSelectOptionItem } from '@ui';
import { AccountsApiService } from '@core/api/accounts-api.service';
import { AnalysisApiService } from '@core/api/analysis-api.service';
import { AGENT_NAME } from '@core/brand';
import type {
  AgentConfigInput,
  AgentSummary,
  ArchetypeCatalogOutput,
  AvailableConversionsOutput,
  MarketReference,
} from '@core/api/generated';
import { MarketReferenceEditor } from '@app/shared/market-reference-editor';
import { AccountContextStore } from '@app/features/account-detail/account-context.store';
import { AgentPlaybook } from './agent-playbook';
import { AgentAutonomy } from './agent-autonomy';
import { AgentGuardrails } from './agent-guardrails';
import { AgentNotifications } from './agent-notifications';
import { AgentPosture } from './agent-posture';

type Conversion = AvailableConversionsOutput['conversions'][number];
/** Um arquétipo do catálogo (chave + rótulo + descrição + quando usar). */
type Archetype = ArchetypeCatalogOutput['archetypes'][number];
/** Overrides de pipeline por-agente (vazio = padrão do sistema). */
type ModelConfig = NonNullable<AgentConfigInput['modelConfig']>;
type ModelQuality = NonNullable<ModelConfig['quality']>;
/** `CadenceSpec` (fonte única do cron) — forma vinda do contrato gerado. */
type Cadence = NonNullable<AgentSummary['cadence']>;
/** Modo do editor de cadência (default = usa o ritmo global; raw = cron avançado). */
type CadenceKind = 'default' | 'daily' | 'twice_daily' | 'weekly' | 'raw';

/** Opções de hora (00:00…23:00) e dia da semana (cron dow) p/ os selects. */
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
/**
 * Toggle de 3 estados p/ os booleans das opções avançadas: "" = usa o padrão do
 * sistema (não envia override), 'on'/'off' = força ligado/desligado.
 */
const TRISTATE_ON = 'on';
const TRISTATE_OFF = 'off';
const TRISTATE_OPTIONS: readonly UiSelectOptionItem[] = [
  { value: '', label: 'Padrão do sistema' },
  { value: TRISTATE_ON, label: 'Ligado' },
  { value: TRISTATE_OFF, label: 'Desligado' },
];

import { CONVERSION_LABEL } from '@app/shared/conversion-label';

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
  readonly persona: string;
  readonly tone: string;
  readonly systemPrompt: string;
  readonly cadence: string; // JSON do CadenceSpec | "" (default) — comparado como string
  readonly windowDays: number;
  readonly modelConfig: string; // JSON dos overrides preenchidos ("{}" = tudo no padrão)
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
  imports: [RouterLink, UiButton, UiPageHeader, UiSpinner, UiSelectBox, NumberStepper, AgentPlaybook, AgentAutonomy, AgentGuardrails, AgentNotifications, AgentPosture, MarketReferenceEditor],
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
              Custo por resultado alvo ({{ accountCurrency() }})
              <input
                type="number" appNumberStepper
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
                type="number" appNumberStepper
                min="0"
                step="0.1"
                class="w-40 rounded-md border border-line bg-app px-3 py-2 text-sm text-ink"
                [value]="targetROAS() ?? ''"
                (input)="onRoas($event)"
              />
            </label>
          </div>
        </section>

        <!-- Período de análise (janela; baseline espelha) -->
        <section class="flex flex-col gap-3 rounded-lg border border-line bg-panel p-5">
          <div class="flex flex-col gap-1">
            <span class="text-xs font-medium uppercase tracking-wide text-muted">Período</span>
            <h2 class="font-brand text-base font-semibold text-ink">Período de análise</h2>
            <p class="text-xs text-muted">
              Quantos dias o agente analisa de cada vez. A comparação usa o mesmo período imediatamente
              anterior. Períodos maiores são mais estáveis; menores reagem mais rápido.
            </p>
          </div>
          <div class="flex flex-wrap gap-2" role="radiogroup" aria-label="Período de análise">
            @for (d of windowPresets; track d) {
              <button
                type="button"
                role="radio"
                [attr.aria-checked]="analysisWindowDays() === d"
                (click)="setWindow(d)"
                class="rounded-md border px-4 py-2 text-sm font-medium transition hover:border-accent/40"
                [class.border-accent]="analysisWindowDays() === d"
                [class.bg-accent-soft]="analysisWindowDays() === d"
                [class.text-ink]="analysisWindowDays() === d"
                [class.border-line]="analysisWindowDays() !== d"
                [class.text-muted]="analysisWindowDays() !== d"
              >
                {{ d }} dias
              </button>
            }
          </div>
        </section>

        <!-- Contexto do negócio (fatos) -->
        <section class="flex flex-col gap-3 rounded-lg border border-line bg-panel p-5">
          <div class="flex flex-col gap-1">
            <span class="text-xs font-medium uppercase tracking-wide text-muted">Sobre o negócio</span>
            <h2 class="font-brand text-base font-semibold text-ink">Contexto do negócio</h2>
            <p class="text-xs text-muted">
              Fatos que ajudam o agente a entender sua realidade — público, oferta, momento do negócio, ticket. Opcional.
            </p>
          </div>
          <textarea
            rows="4"
            [class.border-line]="businessContext().length <= textMax"
            [class.border-danger-strong]="businessContext().length > textMax"
            class="w-full rounded-md border bg-app px-3 py-2 text-sm text-ink"
            placeholder="Ex: campanha de captação até 30/08, público B2B de compras, ticket R$2 mil. Priorizo lead qualificado."
            [value]="businessContext()"
            (input)="onBusinessContext($event)"
          ></textarea>
          <div
            class="flex justify-end gap-1 text-xs"
            [class.text-muted]="businessContext().length <= textMax"
            [class.text-danger-strong]="businessContext().length > textMax"
          >
            @if (businessContext().length > textMax) { <span>acima do limite ·</span> }
            <span>{{ count(businessContext().length) }} / {{ count(textMax) }}</span>
          </div>
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
            [class.border-line]="guidance().length <= textMax"
            [class.border-danger-strong]="guidance().length > textMax"
            class="w-full rounded-md border bg-app px-3 py-2 text-sm text-ink"
            placeholder="Ex: não sugira pausar nos 3 primeiros dias de uma campanha. Priorize escalar o que já bate a meta."
            [value]="guidance()"
            (input)="onGuidance($event)"
          ></textarea>
          <div
            class="flex justify-end gap-1 text-xs"
            [class.text-muted]="guidance().length <= textMax"
            [class.text-danger-strong]="guidance().length > textMax"
          >
            @if (guidance().length > textMax) { <span>acima do limite ·</span> }
            <span>{{ count(guidance().length) }} / {{ count(textMax) }}</span>
          </div>
        </section>

        <!-- Regras (playbook) — componente próprio, salva por regra (fora da save-bar) -->
        <app-agent-playbook [accountId]="accountId" [currency]="accountCurrency()" />

        <app-agent-autonomy [accountId]="accountId" (dirtyChange)="onChildDirty('autonomy', $event)" />

        <app-agent-guardrails [accountId]="accountId" [currency]="accountCurrency()" (dirtyChange)="onChildDirty('guardrails', $event)" />

        <!-- Cadência (ritmo da análise automática) -->
        <section class="flex flex-col gap-3 rounded-lg border border-line bg-panel p-5">
          <div class="flex flex-col gap-1">
            <span class="text-xs font-medium uppercase tracking-wide text-muted">Cadência</span>
            <h2 class="font-brand text-base font-semibold text-ink">Com que frequência analisar</h2>
            <p class="text-xs text-muted">
              De quanto em quanto tempo o agente analisa a conta sozinho. Em momentos críticos, mais vezes ao dia;
              na rotina, semanal já mantém a conta viva.
            </p>
          </div>
          <div class="flex flex-wrap gap-2" role="radiogroup" aria-label="Cadência">
            @for (k of cadenceKinds; track k.value) {
              <button
                type="button"
                role="radio"
                [attr.aria-checked]="cadenceKind() === k.value"
                (click)="setCadenceKind(k.value)"
                class="rounded-md border px-4 py-2 text-sm font-medium transition hover:border-accent/40"
                [class.border-accent]="cadenceKind() === k.value"
                [class.bg-accent-soft]="cadenceKind() === k.value"
                [class.text-ink]="cadenceKind() === k.value"
                [class.border-line]="cadenceKind() !== k.value"
                [class.text-muted]="cadenceKind() !== k.value"
              >
                {{ k.label }}
              </button>
            }
          </div>

          @if (cadenceKind() === 'daily') {
            <div class="flex items-center gap-2 text-sm text-ink">às
              <div class="w-28"><app-ui-select [options]="hourOptions" [value]="cadHourStr()" (valueChange)="onHour($event)" /></div>
            </div>
          }
          @if (cadenceKind() === 'twice_daily') {
            <div class="flex flex-wrap items-center gap-2 text-sm text-ink">às
              <div class="w-28"><app-ui-select [options]="hourOptions" [value]="cadHourStr()" (valueChange)="onHour($event)" /></div>
              e
              <div class="w-28"><app-ui-select [options]="hourOptions" [value]="cadHour2Str()" (valueChange)="onHour2($event)" /></div>
            </div>
          }
          @if (cadenceKind() === 'weekly') {
            <div class="flex flex-wrap items-center gap-2 text-sm text-ink">toda
              <div class="w-36"><app-ui-select [options]="weekdayOptions" [value]="cadWeekdayStr()" (valueChange)="onWeekday($event)" /></div>
              às
              <div class="w-28"><app-ui-select [options]="hourOptions" [value]="cadHourStr()" (valueChange)="onHour($event)" /></div>
            </div>
          }
          <details class="text-xs text-muted">
            <summary class="cursor-pointer select-none">Avançado (expressão cron)</summary>
            <div class="mt-2 flex flex-col gap-1">
              <input
                type="text"
                class="w-full rounded-md border border-line bg-app px-3 py-2 text-sm text-ink"
                placeholder="ex: 0 8,20 * * 1-5"
                [value]="cadCron()"
                (input)="onCron($event)"
                (focus)="setCadenceKind('raw')"
              />
              <span>Cron de 5 campos. Evite intervalos menores que 1h (custo e limites da plataforma).</span>
            </div>
          </details>
          <p class="text-xs text-muted">Fuso: definido em <a routerLink="/settings" class="underline">Configurações</a> da organização.</p>
        </section>

        <!-- Notificações proativas (pulso/alerta/aviso) — componente próprio -->
        <app-agent-notifications [accountId]="accountId" (dirtyChange)="onChildDirty('notifications', $event)" />

        <!-- Postura de comunicação (como o agente FALA) — componente próprio -->
        <app-agent-posture [accountId]="accountId" (dirtyChange)="onChildDirty('posture', $event)" />

        <!-- Arquétipo (preset base) — logo abaixo da cadência -->
        <section class="flex flex-col gap-3 rounded-lg border border-line bg-panel p-5">
          <div class="flex flex-col gap-1">
            <span class="text-xs font-medium uppercase tracking-wide text-muted">Arquétipo</span>
            <h2 class="font-brand text-base font-semibold text-ink">Base do comportamento</h2>
            <p class="text-xs text-muted">
              O preset que define persona, tom e método. Trocar reaplica os padrões dele (sua meta, contexto e
              orientações são preservados).
            </p>
          </div>
          <div class="w-full max-w-sm">
            <app-ui-select [options]="archetypeOptions()" [value]="archetype()" (valueChange)="onArchetypeChange($event)" />
          </div>
          @if (selectedArchetype(); as a) {
            <div class="flex flex-col gap-1">
              <p class="text-sm text-muted">{{ a.description }}</p>
              <p class="text-sm text-muted">
                <span class="font-medium text-ink">Quando usar:</span> {{ a.whenToUse }}
              </p>
            </div>
          }
        </section>

        <!-- Identidade e voz (avançado) -->
        <section class="flex flex-col gap-3 rounded-lg border border-line bg-panel p-5">
          <div class="flex flex-col gap-1">
            <span class="text-xs font-medium uppercase tracking-wide text-muted">Identidade</span>
            <h2 class="font-brand text-base font-semibold text-ink">Como o agente se apresenta</h2>
            <p class="text-xs text-muted">Persona (papel) e tom (jeito) do agente. Opcional — o arquétipo já traz um padrão. O quanto ele é direto, o volume de sugestões e o quanto explica os termos ficam em “Como o agente se comunica”.</p>
          </div>
          <div class="flex flex-col gap-3">
            <label class="flex flex-col gap-1 text-xs text-muted">Persona (papel em 1 linha)
              <input type="text" [class.border-line]="persona().length <= identityMax" [class.border-danger-strong]="persona().length > identityMax" class="w-full rounded-md border bg-app px-3 py-2 text-sm text-ink" placeholder="Ex: gestor de tráfego sênior, especialista em e-commerce" [value]="persona()" (input)="onPersona($event)" />
              <span class="flex justify-end gap-1" [class.text-muted]="persona().length <= identityMax" [class.text-danger-strong]="persona().length > identityMax">
                @if (persona().length > identityMax) { <span>acima do limite ·</span> }
                <span>{{ count(persona().length) }} / {{ count(identityMax) }}</span>
              </span>
            </label>
            <label class="flex flex-col gap-1 text-xs text-muted">Tom (jeito de falar)
              <input type="text" [class.border-line]="tone().length <= identityMax" [class.border-danger-strong]="tone().length > identityMax" class="w-full rounded-md border bg-app px-3 py-2 text-sm text-ink" placeholder="Ex: acolhedor e paciente" [value]="tone()" (input)="onTone($event)" />
              <span class="flex justify-end gap-1" [class.text-muted]="tone().length <= identityMax" [class.text-danger-strong]="tone().length > identityMax">
                @if (tone().length > identityMax) { <span>acima do limite ·</span> }
                <span>{{ count(tone().length) }} / {{ count(identityMax) }}</span>
              </span>
            </label>
          </div>

          <details class="text-xs text-muted">
            <summary class="cursor-pointer select-none">Avançado — substituir a metodologia (para técnicos)</summary>
            <div class="mt-2 flex flex-col gap-2">
              <p>
                Isto substitui as instruções internas de análise do arquétipo pelas suas. Deixe vazio para usar
                o padrão. Seu contexto do negócio e orientações continuam valendo por cima.
              </p>
              <textarea
                rows="6"
                [class.border-line]="systemPrompt().length <= promptMax"
                [class.border-danger-strong]="systemPrompt().length > promptMax"
                class="w-full rounded-md border bg-app px-3 py-2 text-sm text-ink"
                placeholder="Vazio = usa a metodologia do arquétipo."
                [value]="systemPrompt()"
                (input)="onSystemPrompt($event)"
              ></textarea>
              <div
                class="flex justify-end gap-1"
                [class.text-muted]="systemPrompt().length <= promptMax"
                [class.text-danger-strong]="systemPrompt().length > promptMax"
              >
                @if (systemPrompt().length > promptMax) { <span>acima do limite ·</span> }
                <span>{{ count(systemPrompt().length) }} / {{ count(promptMax) }}</span>
              </div>
              <details>
                <summary class="cursor-pointer select-none">Ver a metodologia atual do arquétipo</summary>
                <pre class="mt-2 max-h-64 overflow-auto whitespace-pre-wrap rounded-md border border-line bg-app p-3 text-xs text-muted">{{ methodologyPreview() }}</pre>
              </details>
            </div>
          </details>
        </section>

        <!-- Fonte do criativo na criação (Slice 10) — resultado, sem jargão -->
        <section class="flex flex-col gap-4 rounded-lg border border-line bg-panel p-5">
          <div class="flex flex-col gap-1">
            <span class="text-xs font-medium uppercase tracking-wide text-muted">Criativo</span>
            <h2 class="font-brand text-base font-semibold text-ink">De onde o {{ agentName }} tira o criativo?</h2>
            <p class="text-xs text-muted">Quando ele cria uma campanha nova, qual criativo usar.</p>
          </div>
          <div class="flex flex-col gap-2" role="radiogroup" aria-label="Fonte do criativo">
            @for (o of creativeSourceOptions; track o.value) {
              <button
                type="button"
                role="radio"
                [attr.aria-checked]="creativeSourceMode() === o.value"
                (click)="creativeSourceMode.set(o.value)"
                class="flex items-center justify-between gap-3 rounded-md border px-4 py-3 text-left transition hover:border-accent/40"
                [class.border-accent]="creativeSourceMode() === o.value"
                [class.bg-accent-soft]="creativeSourceMode() === o.value"
                [class.border-line]="creativeSourceMode() !== o.value"
              >
                <span class="flex min-w-0 flex-col gap-0.5">
                  <span class="text-sm font-semibold text-ink"
                    >{{ o.label }}@if (o.recommended) {<span class="ml-1 text-xs font-normal text-muted">recomendado</span>}</span
                  >
                  <span class="text-xs text-muted">{{ o.hint }}</span>
                </span>
                <span
                  class="size-4 shrink-0 rounded-full border transition"
                  [class.border-accent]="creativeSourceMode() === o.value"
                  [class.bg-accent]="creativeSourceMode() === o.value"
                  [class.border-line]="creativeSourceMode() !== o.value"
                  aria-hidden="true"
                ></span>
              </button>
            }
          </div>
        </section>

        <!-- Opções avançadas (divulgação progressiva) — overrides do pipeline por-agente -->
        <section class="flex flex-col gap-3 rounded-lg border border-line bg-panel p-5">
          <details class="flex flex-col gap-3">
            <summary class="cursor-pointer select-none">
              <span class="text-xs font-medium uppercase tracking-wide text-muted">Avançado</span>
              <span class="font-brand text-base font-semibold text-ink"> · Opções avançadas</span>
            </summary>
            <div class="mt-3 flex flex-col gap-6">
              <p class="text-xs text-muted">
                Limiares de qualidade do agente. Deixe em branco para usar o padrão do sistema (mostrado em cada
                campo) — só mexa se souber o efeito.
              </p>

              <!-- Qualidade e limiares -->
              <div class="flex flex-col gap-3">
                <span class="text-sm font-semibold text-ink">Qualidade e limiares</span>
                <div class="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
                  <label class="flex flex-col gap-1 text-xs text-muted" title="Mínimo de conversões para o agente confiar no número e sugerir escalar.">
                    Mínimo de conversões
                    <input type="number" appNumberStepper min="1" step="1" class="w-full rounded-md border border-line bg-app px-3 py-2 text-sm text-ink" [placeholder]="qualityDefaults()?.minConversions ?? ''" [value]="mcMinConversions()" (input)="onMcText(mcMinConversions, $event)" />
                    <span class="text-xs text-muted">Abaixo disso, o agente evita conclusões precipitadas.</span>
                  </label>
                  <label class="flex flex-col gap-1 text-xs text-muted" title="Mínimo de cliques para considerar que já há dado suficiente para avaliar.">
                    Mínimo de cliques
                    <input type="number" appNumberStepper min="1" step="1" class="w-full rounded-md border border-line bg-app px-3 py-2 text-sm text-ink" [placeholder]="qualityDefaults()?.minClicks ?? ''" [value]="mcMinClicks()" (input)="onMcText(mcMinClicks, $event)" />
                    <span class="text-xs text-muted">Volume mínimo de cliques para tirar conclusões.</span>
                  </label>
                  <label class="flex flex-col gap-1 text-xs text-muted" title="Queda de CTR (% em relação ao início) a partir da qual o anúncio é considerado cansado.">
                    Queda de CTR p/ saturação (%)
                    <input type="number" appNumberStepper min="0" step="1" class="w-full rounded-md border border-line bg-app px-3 py-2 text-sm text-ink" [placeholder]="qualityDefaults()?.fatigueCtrDropPct ?? ''" [value]="mcFatigueCtrDropPct()" (input)="onMcText(mcFatigueCtrDropPct, $event)" />
                    <span class="text-xs text-muted">Quanto o interesse pode cair antes de sinalizar cansaço do anúncio.</span>
                  </label>
                  <label class="flex flex-col gap-1 text-xs text-muted" title="Frequência (vezes que a mesma pessoa vê o anúncio) acima da qual consideramos saturação.">
                    Frequência p/ saturação
                    <input type="number" appNumberStepper min="0.1" step="0.1" class="w-full rounded-md border border-line bg-app px-3 py-2 text-sm text-ink" [placeholder]="qualityDefaults()?.fatigueFrequency ?? ''" [value]="mcFatigueFrequency()" (input)="onMcText(mcFatigueFrequency, $event)" />
                    <span class="text-xs text-muted">Quantas vezes a mesma pessoa vê o anúncio antes de saturar.</span>
                  </label>
                  <label class="flex flex-col gap-1 text-xs text-muted" title="Frequência para saturação em público frio (quem ainda não conhece você). Cansa mais rápido.">
                    Frequência p/ saturação — público frio
                    <input type="number" appNumberStepper min="0.1" step="0.1" class="w-full rounded-md border border-line bg-app px-3 py-2 text-sm text-ink" [placeholder]="qualityDefaults()?.frequencyCapByStage?.prospecting ?? ''" [value]="mcFreqCapProspecting()" (input)="onMcText(mcFreqCapProspecting, $event)" />
                    <span class="text-xs text-muted">Quem ainda não te conhece satura com menos repetições.</span>
                  </label>
                  <label class="flex flex-col gap-1 text-xs text-muted" title="Frequência para saturação em público quente (remarketing). Tolera mais repetições.">
                    Frequência p/ saturação — público quente
                    <input type="number" appNumberStepper min="0.1" step="0.1" class="w-full rounded-md border border-line bg-app px-3 py-2 text-sm text-ink" [placeholder]="qualityDefaults()?.frequencyCapByStage?.remarketing ?? ''" [value]="mcFreqCapRemarketing()" (input)="onMcText(mcFreqCapRemarketing, $event)" />
                    <span class="text-xs text-muted">Quem já te conhece (remarketing) aguenta ver mais vezes.</span>
                  </label>
                  <label class="flex flex-col gap-1 text-xs text-muted" title="Alta de custo por resultado (%) a partir da qual o anúncio é considerado cansado.">
                    Alta de custo p/ saturação (%)
                    <input type="number" appNumberStepper min="0" step="1" class="w-full rounded-md border border-line bg-app px-3 py-2 text-sm text-ink" [placeholder]="qualityDefaults()?.fatigueCostRisePct ?? ''" [value]="mcFatigueCostRisePct()" (input)="onMcText(mcFatigueCostRisePct, $event)" />
                    <span class="text-xs text-muted">Quanto o custo pode subir antes de sinalizar cansaço.</span>
                  </label>
                  <label class="flex flex-col gap-1 text-xs text-muted" title="Ligar/desligar a referência de mercado quando a conta ainda não tem meta nem histórico.">
                    Usar referência de mercado
                    <app-ui-select [options]="tristateOptions" [value]="mcColdStartReference()" (valueChange)="mcColdStartReference.set($event)" />
                    <span class="text-xs text-muted">Liga/desliga o bloco de referência (custo + CTR) no cold-start.</span>
                  </label>
                  <label class="flex flex-col gap-1 text-xs text-muted" title="Quantas conversas por conversão registrada até desconfiar que o rastreamento de conversões está incompleto.">
                    Conversas por conversão p/ suspeitar da medição
                    <input type="number" appNumberStepper min="1" step="1" class="w-full rounded-md border border-line bg-app px-3 py-2 text-sm text-ink" [placeholder]="qualityDefaults()?.trackingBrokenRatio ?? ''" [value]="mcTrackingBrokenRatio()" (input)="onMcText(mcTrackingBrokenRatio, $event)" />
                    <span class="text-xs text-muted">Muitas conversas e quase nenhuma conversão registrada sugere rastreamento furado.</span>
                  </label>
                  <label class="flex flex-col gap-1 text-xs text-muted" title="Mínimo de conversas para sequer considerar a suspeita de medição incompleta.">
                    Mínimo de conversas p/ avaliar a medição
                    <input type="number" appNumberStepper min="0" step="1" class="w-full rounded-md border border-line bg-app px-3 py-2 text-sm text-ink" [placeholder]="qualityDefaults()?.trackingBrokenMinFunnel ?? ''" [value]="mcTrackingBrokenMinFunnel()" (input)="onMcText(mcTrackingBrokenMinFunnel, $event)" />
                    <span class="text-xs text-muted">Abaixo desse volume de conversas, o agente não levanta a suspeita.</span>
                  </label>
                  <label class="flex flex-col gap-1 text-xs text-muted" title="Gasto mínimo (em múltiplo da meta de custo) para julgar uma campanha, mesmo com poucas conversões registradas.">
                    Múltiplo da meta de custo p/ piso de gasto
                    <input type="number" appNumberStepper min="1" step="0.5" class="w-full rounded-md border border-line bg-app px-3 py-2 text-sm text-ink" [placeholder]="qualityDefaults()?.relativeEligibilitySpendMultiplier ?? ''" [value]="mcRelativeEligibilitySpendMultiplier()" (input)="onMcText(mcRelativeEligibilitySpendMultiplier, $event)" />
                    <span class="text-xs text-muted">Gastou esse múltiplo da meta de custo (ex: 2× R$7 = R$14) já conta como volume suficiente pra julgar, mesmo com poucas conversões.</span>
                  </label>
                  <label class="flex flex-col gap-1 text-xs text-muted" title="Alta do custo por resultado (%) a partir da qual o agente para de recomendar escalar orçamento, mesmo que a média ainda pareça boa.">
                    Alta de custo p/ parar de escalar (%)
                    <input type="number" appNumberStepper min="1" step="1" class="w-full rounded-md border border-line bg-app px-3 py-2 text-sm text-ink" [placeholder]="qualityDefaults()?.marginalCpaWorsenPct ?? ''" [value]="mcMarginalCpaWorsenPct()" (input)="onMcText(mcMarginalCpaWorsenPct, $event)" />
                    <span class="text-xs text-muted">O custo médio pode parecer bom, mas se o incremento mais recente já subiu esse tanto, o agente sugere investigar em vez de continuar aumentando.</span>
                  </label>
                  <label class="flex flex-col gap-1 text-xs text-muted" title="Retenção de vídeo (%) abaixo da qual o agente considera que o vídeo não segura a atenção nos primeiros segundos.">
                    Retenção mínima de vídeo (%)
                    <input type="number" appNumberStepper min="1" max="100" step="1" class="w-full rounded-md border border-line bg-app px-3 py-2 text-sm text-ink" [placeholder]="qualityDefaults()?.weakHookRetentionMaxPct ?? ''" [value]="mcWeakHookRetentionMaxPct()" (input)="onMcText(mcWeakHookRetentionMaxPct, $event)" />
                    <span class="text-xs text-muted">Se menos que essa % das pessoas continua assistindo o vídeo além do início, o agente aponta o gancho como fraco (direção de criativo, nunca pausa sozinho).</span>
                  </label>
                </div>

                <!-- Referência de mercado desta conta (override do padrão da org) -->
                <div class="mt-4 flex flex-col gap-2 border-t border-line pt-4">
                  <span class="text-sm font-medium text-ink">Referência de mercado desta conta</span>
                  <span class="text-xs text-muted">
                    Ajusta as faixas para este cliente. Vazio herda o padrão da organização (Configurações).
                  </span>
                  <app-market-reference-editor
                    [value]="marketRefOverride()"
                    [currency]="accountCurrency()"
                    [currencyEditable]="false"
                    (valueChange)="marketRefOverride.set($event)"
                  />
                </div>
              </div>
            </div>
          </details>
        </section>

        <!-- Save bar ÚNICA (dirty combinado: campos da página + todas as seções) -->
        <div class="sticky bottom-0 z-10 flex items-center justify-between gap-3 rounded-lg border border-line bg-panel p-4 shadow-card">
          <span
            class="text-sm"
            [class.text-muted]="!combinedDirty() && !textOverLimit()"
            [class.text-ink]="combinedDirty() && !textOverLimit()"
            [class.text-danger-strong]="textOverLimit()"
          >
            {{ textOverLimit() ? 'Encurte os campos acima do limite para salvar' : combinedDirty() ? 'Alterações não salvas' : 'Configuração salva' }}
          </span>
          <button appButton variant="primary" type="button" [disabled]="!combinedDirty() || saving() || textOverLimit()" (click)="save()">
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
  private readonly confirmDialog = inject(UiConfirmDialogService);
  private readonly destroyRef = inject(DestroyRef);
  /** Store da conta (provido pelo AccountShell; a aba de config é rota-filha). Opcional —
   *  se a config for aberta fora do shell, segue sem o refresh do gate. */
  private readonly accountStore = inject(AccountContextStore, { optional: true });

  protected readonly accountId = this.route.snapshot.paramMap.get('id') ?? '';
  private destroyed = false;

  protected readonly loading = signal(true);
  protected readonly saving = signal(false);
  protected readonly accountName = signal('Conta');

  // form
  protected readonly businessContext = signal('');
  protected readonly guidance = signal('');
  protected readonly targetCPA = signal<number | null>(null);
  protected readonly targetROAS = signal<number | null>(null);
  protected readonly conversionKey = signal(''); // `${goal}:${cid}` ("" = sem conversão de negócio)
  protected readonly analysisWindowDays = signal<number>(DEFAULT_WINDOW_DAYS);
  protected readonly windowPresets = WINDOW_PRESETS;

  // identidade/voz (c2)
  protected readonly persona = signal('');
  protected readonly tone = signal('');
  protected readonly systemPrompt = signal('');
  protected readonly methodologyPreview = signal('');
  protected readonly archetype = signal('conservador');
  /** Catálogo vindo do backend (label + descrição + quando usar). */
  private readonly archetypeCatalog = signal<Archetype[]>([]);
  /** Opções do select (só key + label). */
  protected readonly archetypeOptions = computed<UiSelectOptionItem[]>(() =>
    this.archetypeCatalog().map((a) => ({ value: a.key, label: a.label })),
  );
  /** Arquétipo selecionado (p/ mostrar descrição + quando usar abaixo do select). */
  protected readonly selectedArchetype = computed<Archetype | null>(
    () => this.archetypeCatalog().find((a) => a.key === this.archetype()) ?? null,
  );

  // opções avançadas — só limiares de qualidade (vazio = usa o padrão do sistema).
  // Os knobs técnicos (modelos/IA, top-N, tokens, revisão) saíram da UI (roadmap:
  // "Opções avançadas técnicas"); seguem overridáveis por env/model_config.
  protected readonly tristateOptions = TRISTATE_OPTIONS;
  /** defaults do sistema (env) — placeholder real dos campos vazios. */
  protected readonly qualityDefaults = signal<AgentSummary['qualityDefaults'] | null>(null);
  protected readonly agentName = AGENT_NAME;
  /** De onde o Roy tira o criativo pra campanhas novas (Slice 10) — 3 resultados claros. */
  protected readonly creativeSourceMode = signal<'serving' | 'both' | 'library'>('serving');
  protected readonly creativeSourceOptions = [
    { value: 'serving' as const, label: 'Reaproveitar o que já está funcionando', recommended: true, hint: 'Usa um anúncio que já roda bem na sua conta.' },
    { value: 'both' as const, label: `Deixar o ${AGENT_NAME} escolher`, recommended: false, hint: 'Ele compara os anúncios no ar e os da sua biblioteca e escolhe o que mais combina com a campanha.' },
    { value: 'library' as const, label: 'Usar só a minha biblioteca', recommended: false, hint: 'Escolhe entre os criativos que você subiu.' },
  ];
  protected readonly mcMinConversions = signal('');
  protected readonly mcMinClicks = signal('');
  protected readonly mcFatigueCtrDropPct = signal('');
  protected readonly mcFatigueFrequency = signal('');
  protected readonly mcFreqCapProspecting = signal('');
  protected readonly mcFreqCapRemarketing = signal('');
  protected readonly mcFatigueCostRisePct = signal('');
  protected readonly mcZombieMinSpend = signal('');
  protected readonly mcColdStartReference = signal(''); // '' | 'on' | 'off'
  protected readonly mcTrackingBrokenRatio = signal('');
  protected readonly mcTrackingBrokenMinFunnel = signal('');
  protected readonly mcRelativeEligibilitySpendMultiplier = signal('');
  protected readonly mcMarginalCpaWorsenPct = signal('');
  protected readonly mcWeakHookRetentionMaxPct = signal('');
  // referência de mercado desta conta (override do padrão da org) — pivô.
  // moeda = a da conta (fixa no editor). null = herda da org.
  protected readonly accountCurrency = signal('BRL');
  protected readonly marketRefOverride = signal<MarketReference | null>(null);

  // cadência (c2) — sub-estado do editor; compõe o CadenceSpec.
  protected readonly cadenceKind = signal<CadenceKind>('default');
  protected readonly cadHour = signal(8);
  protected readonly cadHour2 = signal(20);
  protected readonly cadWeekday = signal(1);
  protected readonly cadCron = signal('');
  protected readonly hourOptions = HOUR_OPTIONS;
  protected readonly weekdayOptions = WEEKDAY_OPTIONS;
  // valores string dos selects (o UiSelect fala string; convertemos na borda).
  protected readonly cadHourStr = computed(() => String(this.cadHour()));
  protected readonly cadHour2Str = computed(() => String(this.cadHour2()));
  protected readonly cadWeekdayStr = computed(() => String(this.cadWeekday()));
  protected readonly cadenceKinds: readonly { value: CadenceKind; label: string }[] = [
    { value: 'default', label: 'Padrão do sistema' },
    { value: 'daily', label: 'Diária' },
    { value: 'twice_daily', label: '2× ao dia' },
    { value: 'weekly', label: 'Semanal' },
  ];

  /** Compõe o `CadenceSpec` a partir do sub-estado (null = usa o ritmo global). */
  protected readonly cadenceSpec = computed<Cadence | null>(() => {
    switch (this.cadenceKind()) {
      case 'daily':
        return { kind: 'daily', hour: this.cadHour() };
      case 'twice_daily':
        return { kind: 'twice_daily', hours: [this.cadHour(), this.cadHour2()] };
      case 'weekly':
        return { kind: 'weekly', weekday: this.cadWeekday(), hour: this.cadHour() };
      case 'raw': {
        const cron = this.cadCron().trim();
        return cron ? { kind: 'raw', cron } : null;
      }
      default:
        return null;
    }
  });

  private readonly available = signal<Conversion[]>([]);
  protected readonly conversionQuery = signal('');
  /** snapshot inicial (config carregada) — dirty = form atual difere daqui. */
  private readonly initial = signal<FormState>(EMPTY_FORM);

  protected readonly dirty = computed(() => !sameForm(this.current(), this.initial()));

  // Seções self-contained (autonomia/guardrails/notificações/postura): a save-bar é
  // ÚNICA — o dirty combina os campos da página + o dirty emitido por cada seção, e o
  // "Salvar configuração" persiste tudo (seções primeiro, sequencial p/ evitar corrida
  // na escrita da linha do agente, depois os campos da página).
  @ViewChild(AgentAutonomy) private autonomy?: AgentAutonomy;
  @ViewChild(AgentGuardrails) private guardrails?: AgentGuardrails;
  @ViewChild(AgentNotifications) private notifications?: AgentNotifications;
  @ViewChild(AgentPosture) private posture?: AgentPosture;
  private readonly childDirty = signal<Record<string, boolean>>({});
  protected onChildDirty(key: string, v: boolean): void {
    this.childDirty.update((m) => (m[key] === v ? m : { ...m, [key]: v }));
  }
  protected readonly combinedDirty = computed(
    () => this.dirty() || Object.values(this.childDirty()).some(Boolean),
  );

  // Tetos dos campos de texto (espelham @trafego/shared: mesmo limite no site, na API
  // e no auto-config por chat). Expostos ao template p/ o contador + o bloqueio de save.
  protected readonly textMax = TEXT_FIELD_MAX;
  protected readonly identityMax = IDENTITY_FIELD_MAX;
  protected readonly promptMax = PROMPT_FIELD_MAX;
  /** Formata a contagem com separador de milhar PT (ex: "8.000"). */
  protected count(n: number): string {
    return n.toLocaleString('pt-BR');
  }
  /** Algum campo de texto passou do teto → contador vermelho + save bloqueado. */
  protected readonly textOverLimit = computed(
    () =>
      this.businessContext().length > TEXT_FIELD_MAX ||
      this.guidance().length > TEXT_FIELD_MAX ||
      this.persona().length > IDENTITY_FIELD_MAX ||
      this.tone().length > IDENTITY_FIELD_MAX ||
      this.systemPrompt().length > PROMPT_FIELD_MAX,
  );

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

  protected setWindow(days: number): void {
    this.analysisWindowDays.set(days);
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
  protected onPersona(e: Event): void {
    this.persona.set((e.target as HTMLInputElement).value);
  }
  protected onTone(e: Event): void {
    this.tone.set((e.target as HTMLInputElement).value);
  }
  protected onSystemPrompt(e: Event): void {
    this.systemPrompt.set((e.target as HTMLTextAreaElement).value);
  }

  /** Handler genérico dos campos de texto/número das opções avançadas. */
  protected onMcText(sig: WritableSignal<string>, e: Event): void {
    sig.set((e.target as HTMLInputElement).value);
  }

  protected setCadenceKind(kind: CadenceKind): void {
    this.cadenceKind.set(kind);
  }
  protected onHour(v: string): void {
    this.cadHour.set(Number(v));
  }
  protected onHour2(v: string): void {
    this.cadHour2.set(Number(v));
  }
  protected onWeekday(v: string): void {
    this.cadWeekday.set(Number(v));
  }
  protected onCron(e: Event): void {
    this.cadCron.set((e.target as HTMLInputElement).value);
  }

  /** Troca de arquétipo: confirma (reaplica padrões) e re-semeia via backend. */
  protected async onArchetypeChange(next: string): Promise<void> {
    if (next === this.archetype()) return;
    const ok = await this.confirmDialog.confirm({
      title: 'Trocar o arquétipo?',
      description:
        'Reaplica os padrões dele: persona, tom, método, autonomia, notificações e a postura de comunicação (como o agente fala). Sua meta, contexto e orientações são preservados.',
      confirmLabel: 'Trocar',
      tone: 'warning',
    });
    // cancelou → o select reverte sozinho (é controlado por [value]="archetype()").
    if (!ok) return;
    this.analysisApi.reseedArchetype(this.accountId, next).subscribe({
      next: (agent) => {
        this.applyAgent(agent);
        toast.success(`Arquétipo aplicado. Ajustei o ${AGENT_NAME} pra esse perfil.`);
      },
      error: () => {},
    });
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

  /**
   * Save ÚNICO: persiste as seções (sequencial — cada saveConfig reescreve a linha do
   * agente a partir do estado FRESCO, então em paralelo se sobrescreveriam) e depois os
   * campos da página. Um toast só. Erro amigável vem do interceptor global.
   */
  protected async save(): Promise<void> {
    if (!this.combinedDirty() || this.textOverLimit()) return;
    this.saving.set(true);
    try {
      // cada seção devolve se REALMENTE persistiu: `false` = tinha mudança mas a seção não
      // carregou (seed falhou) e foi pulada — sem isto o toast mentia "salvo" (F-FALSE-SAVE).
      // `undefined` = a seção nem existe no DOM (ViewChild ausente) → não conta como falha.
      const persisted = [
        await this.autonomy?.save(),
        await this.guardrails?.save(),
        await this.notifications?.save(),
        await this.posture?.save(),
      ];
      if (this.dirty()) {
        const agent = await firstValueFrom(this.analysisApi.saveConfig(this.accountId, this.buildInput()));
        this.applyAgent(agent); // reseed dos campos + baseline (limpa o dirty da página)
      }
      // gate de escala (bindings) pode ter mudado na aba de autonomia → re-lê no shell.
      this.accountStore?.refreshGate();
      if (persisted.some((ok) => ok === false)) {
        toast.warning('Salvei o que deu, mas uma seção não tinha carregado. Recarregue a página e revise.');
      } else {
        toast.success('Configuração salva');
      }
    } catch {
      // interceptor global já mostrou o erro amigável.
    } finally {
      this.saving.set(false);
    }
  }

  private current(): FormState {
    return {
      targetCPA: this.targetCPA(),
      targetROAS: this.targetROAS(),
      conversionKey: this.conversionKey(),
      businessContext: this.businessContext(),
      guidance: this.guidance(),
      persona: this.persona(),
      tone: this.tone(),
      systemPrompt: this.systemPrompt(),
      cadence: JSON.stringify(this.cadenceSpec()),
      windowDays: this.analysisWindowDays(),
      modelConfig: JSON.stringify(this.buildModelConfig()),
    };
  }

  /**
   * Monta os overrides preenchidos (só o que o usuário informou; vazio = padrão do
   * sistema, então some do objeto). `quality` só entra quando tem algum campo.
   */
  private buildModelConfig(): ModelConfig {
    // frequência por estágio é objeto aninhado {prospecting?, remarketing?} — só entra
    // quando o usuário informou algum dos dois (vazio = padrão do sistema).
    const prospecting = numOrUndef(this.mcFreqCapProspecting());
    const remarketing = numOrUndef(this.mcFreqCapRemarketing());
    const frequencyCapByStage = {
      ...(prospecting !== undefined ? { prospecting } : {}),
      ...(remarketing !== undefined ? { remarketing } : {}),
    };
    const quality: ModelQuality = {
      ...intField('minConversions', this.mcMinConversions()),
      ...intField('minClicks', this.mcMinClicks()),
      ...numField('fatigueCtrDropPct', this.mcFatigueCtrDropPct()),
      ...numField('fatigueFrequency', this.mcFatigueFrequency()),
      ...(Object.keys(frequencyCapByStage).length > 0 ? { frequencyCapByStage } : {}),
      ...numField('fatigueCostRisePct', this.mcFatigueCostRisePct()),
      ...numField('zombieMinSpend', this.mcZombieMinSpend()),
      ...boolField('coldStartReference', this.mcColdStartReference()),
      ...numField('trackingBrokenRatio', this.mcTrackingBrokenRatio()),
      ...numField('trackingBrokenMinFunnel', this.mcTrackingBrokenMinFunnel()),
      ...numField('relativeEligibilitySpendMultiplier', this.mcRelativeEligibilitySpendMultiplier()),
      ...numField('marginalCpaWorsenPct', this.mcMarginalCpaWorsenPct()),
      ...numField('weakHookRetentionMaxPct', this.mcWeakHookRetentionMaxPct()),
      ...(this.marketRefOverride() ? { marketReference: this.marketRefOverride()! } : {}),
    };
    // fonte do criativo: mapeia o RESULTADO escolhido → {mode, servingPick}. "serving" carrega
    // servingPick=best_performing (determinístico, sem LLM = default de hoje); "both" = o Roy
    // escolhe entre no ar + biblioteca; "library" = só a biblioteca.
    const mode = this.creativeSourceMode();
    const creativeSource = mode === 'serving' ? { mode, servingPick: 'best_performing' as const } : { mode };
    return {
      creativeSource,
      ...(Object.keys(quality).length > 0 ? { quality } : {}),
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
    // modelConfig só entra quando há algum override (vazio = não mexe; evita forçar
    // deep num save que só mudou cadência — o backend trata modelConfig presente como
    // relevante à análise).
    const modelConfig = this.buildModelConfig();
    // Campos de texto só entram no PATCH quando MUDARAM (vs. o baseline carregado):
    // reenviar um texto grande legado (ex: gravado por chat sem teto antigo) barraria
    // um save que só mexeu na cadência. Trim espelha o comparador de dirty (sameForm).
    const base = this.initial();
    const changed = (cur: string, prev: string): boolean => cur.trim() !== prev.trim();
    return {
      goals,
      ...(changed(this.businessContext(), base.businessContext) ? { businessContext: this.businessContext() } : {}),
      ...(changed(this.guidance(), base.guidance) ? { guidance: this.guidance() } : {}),
      ...(changed(this.persona(), base.persona) ? { persona: this.persona() } : {}),
      ...(changed(this.tone(), base.tone) ? { tone: this.tone() } : {}),
      ...(changed(this.systemPrompt(), base.systemPrompt) ? { systemPrompt: this.systemPrompt() } : {}),
      cadence: this.cadenceSpec(),
      analysisWindowDays: this.analysisWindowDays(),
      ...(Object.keys(modelConfig).length > 0 ? { modelConfig } : {}),
    };
  }

  /** Aplica a config do agente aos signals (usado no load e após re-seed). */
  private applyAgent(agent: AgentSummary): void {
    this.businessContext.set(agent.businessContext ?? '');
    this.guidance.set(agent.guidance ?? '');
    this.persona.set(agent.persona ?? '');
    this.tone.set(agent.tone ?? '');
    this.systemPrompt.set(agent.systemPrompt ?? '');
    this.methodologyPreview.set(agent.methodologyPreview ?? '');
    this.archetype.set(agent.archetype);
    this.targetCPA.set(agent.goals.targetCPA ?? null);
    this.targetROAS.set(agent.goals.targetROAS ?? null);
    this.conversionKey.set(
      agent.goals.conversionGoal
        ? keyOf(agent.goals.conversionGoal, agent.goals.customConversionId ?? '')
        : '',
    );
    this.analysisWindowDays.set(agent.analysisWindowDays ?? DEFAULT_WINDOW_DAYS);
    this.applyCadence(agent.cadence ?? null);
    this.qualityDefaults.set(agent.qualityDefaults);
    this.accountCurrency.set(agent.currency ?? 'BRL');
    this.applyModelConfig(agent.modelConfig);
    this.initial.set(this.current()); // baseline p/ o dirty
  }

  /** Semeia as opções avançadas com os overrides atuais (ausente = campo vazio = padrão). */
  private applyModelConfig(mc: AgentSummary['modelConfig'] | undefined): void {
    const c = mc ?? {};
    const q = c.quality ?? {};
    this.mcMinConversions.set(numToStr(q.minConversions));
    this.mcMinClicks.set(numToStr(q.minClicks));
    this.mcFatigueCtrDropPct.set(numToStr(q.fatigueCtrDropPct));
    this.mcFatigueFrequency.set(numToStr(q.fatigueFrequency));
    this.mcFreqCapProspecting.set(numToStr(q.frequencyCapByStage?.prospecting));
    this.mcFreqCapRemarketing.set(numToStr(q.frequencyCapByStage?.remarketing));
    this.mcFatigueCostRisePct.set(numToStr(q.fatigueCostRisePct));
    this.mcZombieMinSpend.set(numToStr(q.zombieMinSpend));
    this.mcColdStartReference.set(triFrom(q.coldStartReference));
    this.mcTrackingBrokenRatio.set(numToStr(q.trackingBrokenRatio));
    this.mcTrackingBrokenMinFunnel.set(numToStr(q.trackingBrokenMinFunnel));
    this.mcRelativeEligibilitySpendMultiplier.set(numToStr(q.relativeEligibilitySpendMultiplier));
    this.mcMarginalCpaWorsenPct.set(numToStr(q.marginalCpaWorsenPct));
    this.mcWeakHookRetentionMaxPct.set(numToStr(q.weakHookRetentionMaxPct));
    this.marketRefOverride.set(q.marketReference ?? null);
    // fonte do criativo: `both`/`library` explícitos; qualquer serving.* → o resultado "reaproveitar".
    const cs = c.creativeSource?.mode;
    this.creativeSourceMode.set(cs === 'both' ? 'both' : cs === 'library' ? 'library' : 'serving');
  }

  /** Decompõe o `CadenceSpec` salvo no sub-estado do editor. */
  private applyCadence(cadence: Cadence | null): void {
    if (!cadence) {
      this.cadenceKind.set('default');
      return;
    }
    this.cadenceKind.set(cadence.kind);
    if (cadence.kind === 'daily') this.cadHour.set(cadence.hour);
    else if (cadence.kind === 'twice_daily') {
      this.cadHour.set(cadence.hours[0]);
      this.cadHour2.set(cadence.hours[1]);
    } else if (cadence.kind === 'weekly') {
      this.cadWeekday.set(cadence.weekday);
      this.cadHour.set(cadence.hour);
    } else if (cadence.kind === 'raw') this.cadCron.set(cadence.cron);
  }

  private load(): void {
    this.accountsApi.list().subscribe({
      next: (rows) => {
        const acc = rows.find((r) => r.id === this.accountId);
        if (acc) this.accountName.set(acc.name ?? acc.adAccountId);
      },
      error: () => {},
    });
    // catálogo de arquétipos (rótulo + descrição + quando usar) — silencioso, pode vir vazio.
    this.analysisApi.archetypes().subscribe({
      next: (out) => this.archetypeCatalog.set(out.archetypes),
      error: () => this.archetypeCatalog.set([]),
    });
    // conversões disponíveis (anotação do select) — silenciosa, pode vir vazia.
    this.analysisApi.availableConversions(this.accountId).subscribe({
      next: (out) => this.available.set(out.conversions),
      error: () => this.available.set([]),
    });
    this.analysisApi.getAgent(this.accountId).subscribe({
      next: (agent) => {
        this.applyAgent(agent);
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

/** Presets do período de análise (dias) + default — espelham o backend (1..30). */
const WINDOW_PRESETS = [7, 14, 30] as const;
const DEFAULT_WINDOW_DAYS = 7;

// Tetos de texto — espelham AGENT_TEXT_FIELD_MAX/_IDENTITY_/_PROMPT_ de @trafego/shared
// (o web não importa o pacote; mantém a cópia como brand.ts faz com o nome do agente).
const TEXT_FIELD_MAX = 8000;
const IDENTITY_FIELD_MAX = 280;
const PROMPT_FIELD_MAX = 8000;

const EMPTY_FORM: FormState = {
  targetCPA: null,
  targetROAS: null,
  conversionKey: '',
  businessContext: '',
  guidance: '',
  persona: '',
  tone: '',
  systemPrompt: '',
  cadence: 'null',
  windowDays: DEFAULT_WINDOW_DAYS,
  modelConfig: '{}',
};

function sameForm(a: FormState, b: FormState): boolean {
  return (
    a.targetCPA === b.targetCPA &&
    a.targetROAS === b.targetROAS &&
    a.conversionKey === b.conversionKey &&
    a.businessContext.trim() === b.businessContext.trim() &&
    a.guidance.trim() === b.guidance.trim() &&
    a.persona.trim() === b.persona.trim() &&
    a.tone.trim() === b.tone.trim() &&
    a.systemPrompt.trim() === b.systemPrompt.trim() &&
    a.cadence === b.cadence &&
    a.windowDays === b.windowDays &&
    a.modelConfig === b.modelConfig
  );
}

/** "" (após trim) = campo vazio = usa o padrão do sistema (não vira override). */
/** Inteiro finito ou nada (vazio/ inválido = padrão do sistema). */
function intField(key: string, value: string): Record<string, number> {
  const v = value.trim();
  if (v.length === 0) return {};
  const n = Number(v);
  return Number.isFinite(n) ? { [key]: Math.trunc(n) } : {};
}
/** Número finito ou nada (vazio/ inválido = padrão do sistema). */
function numField(key: string, value: string): Record<string, number> {
  const v = value.trim();
  if (v.length === 0) return {};
  const n = Number(v);
  return Number.isFinite(n) ? { [key]: n } : {};
}
/** Número finito ou undefined (p/ campos aninhados tipados, ex: frequencyCapByStage). */
function numOrUndef(value: string): number | undefined {
  const v = value.trim();
  if (v.length === 0) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}
/** Toggle de 3 estados → override booleano só quando 'on'/'off' ("" = padrão). */
function boolField(key: string, tri: string): Record<string, boolean> {
  if (tri === TRISTATE_ON) return { [key]: true };
  if (tri === TRISTATE_OFF) return { [key]: false };
  return {};
}
/** Booleano do backend → estado do toggle de 3 estados (undefined = padrão = ""). */
function triFrom(value: boolean | undefined): string {
  if (value === undefined) return '';
  return value ? TRISTATE_ON : TRISTATE_OFF;
}
/** Número do backend → texto do input (undefined = vazio). */
function numToStr(value: number | undefined): string {
  return value != null ? String(value) : '';
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
