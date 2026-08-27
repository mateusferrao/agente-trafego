import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormControl, FormRecord, ReactiveFormsModule, Validators } from '@angular/forms';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideCheck, lucideTriangleAlert, lucideX } from '@ng-icons/lucide';
import {
  UiButton,
  UiDialog,
  UiDialogDescription,
  UiDialogOverlay,
  UiDialogTitle,
  UiFormField,
  UiHint,
  UiInput,
  UiLabel,
  UiSpinner,
} from '@ui';
import { AGENT_NAME } from '@core/brand';
import { CONNECTOR_REGISTRY, resolveConnector } from '../connectors/connector-registry';
import type { ConnectResult, SelectableTarget } from '../domain/connect-result';
import type { ProviderCatalogEntry } from '../domain/provider-catalog-entry';

type Step = 'intro' | 'credentials' | 'connecting' | 'select' | 'success' | 'error';

export interface ConnectDialogDoneEvent {
  readonly result: ConnectResult;
}

/** Total de "dots" do progresso (intro → conectar → escolher → concluído). */
const STEP_INDEX: Record<Step, number> = {
  intro: 0,
  credentials: 1,
  connecting: 1,
  select: 2,
  success: 3,
  error: 1,
};
const STEP_DOTS = [0, 1, 2, 3] as const;

/**
 * Dialog genérico de conexão de provedor, dirigido por `ConnectorStrategy` do
 * registry (extend desta fatia: passo `select` p/ escolher um alvo — ex: a ad
 * account da Meta). Agnóstico de provider: só renderiza + orquestra os steps.
 */
@Component({
  selector: 'app-connect-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    ReactiveFormsModule,
    NgIcon,
    UiButton,
    UiDialog,
    UiDialogDescription,
    UiDialogOverlay,
    UiDialogTitle,
    UiFormField,
    UiHint,
    UiInput,
    UiLabel,
    UiSpinner,
  ],
  providers: [provideIcons({ lucideCheck, lucideTriangleAlert, lucideX })],
  template: `
    <div appDialogOverlay>
      <section appDialog class="connect-dialog" aria-labelledby="connect-dialog-title" [ngpDialogModal]="true">
        <header class="head">
          <div>
            <span appUiLabel class="mb-1 block uppercase">Conectar provedor</span>
            <h2 appDialogTitle id="connect-dialog-title">{{ entry().name }}</h2>
            <p appDialogDescription>{{ entry().description }}</p>
          </div>
          <button
            appButton
            variant="ghost"
            size="sm"
            type="button"
            (click)="cancel()"
            [disabled]="step() === 'connecting'"
            aria-label="Fechar"
          >
            <ng-icon name="lucideX" size="17" aria-hidden="true" />
          </button>
        </header>

        <div class="steps" aria-hidden="true">
          @for (dot of stepDots; track dot) {
            <span class="dot" [class.dot--current]="dot === stepIndex()" [class.dot--done]="dot < stepIndex()"></span>
          }
        </div>

        <div class="body">
          @switch (step()) {
            @case ('intro') {
              <div>
                <p appUiHint class="intro-hint">{{ introText() }}</p>
                @if (assurances().length || entry().docsUrl) {
                  <ul class="bullets">
                    @for (item of assurances(); track item) {
                      <li>{{ item }}</li>
                    }
                    @if (entry().docsUrl) {
                      <li>
                        <a [href]="entry().docsUrl" target="_blank" rel="noreferrer noopener">
                          Como gerar o token ↗
                        </a>
                      </li>
                    }
                  </ul>
                }
              </div>
            }
            @case ('credentials') {
              <div>
                @if (credentialForm()?.description) {
                  <p appUiHint class="intro-hint">{{ credentialForm()!.description }}</p>
                }
                <form [formGroup]="form" (ngSubmit)="submitCredentials()" class="flex flex-col gap-3">
                  @for (field of credentialForm()?.fields ?? []; track field.name) {
                    <app-ui-form-field [label]="field.label" [hint]="field.helpText ?? ''">
                      <input
                        appInput
                        [formControlName]="field.name"
                        [placeholder]="field.placeholder ?? ''"
                        [type]="field.secret ? 'password' : 'text'"
                        autocomplete="off"
                      />
                    </app-ui-form-field>
                  }
                </form>
              </div>
            }
            @case ('connecting') {
              <div class="centered">
                <app-ui-spinner aria-hidden="true" />
                <p appUiHint class="centered-hint">Falando com a Meta…</p>
              </div>
            }
            @case ('select') {
              @if (targets().length === 0) {
                <div class="centered">
                  <p class="title">Nenhuma conta encontrada</p>
                  <p appUiHint class="centered-hint">
                    Esse token não tem nenhuma conta de anúncio. Verifique e tente com outro.
                  </p>
                </div>
              } @else {
                <p appUiHint class="intro-hint">Escolha uma ou mais contas para o agente acompanhar.</p>
                <div class="flex flex-col gap-2" role="group" aria-label="Contas de anúncio">
                  @for (target of targets(); track target.id) {
                    <button
                      type="button"
                      role="checkbox"
                      [attr.aria-checked]="isSelected(target.id)"
                      (click)="toggleTarget(target.id)"
                      (keydown.enter)="toggleTarget(target.id); $event.preventDefault()"
                      (keydown.space)="toggleTarget(target.id); $event.preventDefault()"
                      class="flex items-center justify-between gap-3 rounded-md border px-4 py-3 text-left transition hover:border-accent/40"
                      [class.border-accent]="isSelected(target.id)"
                      [class.bg-accent-soft]="isSelected(target.id)"
                      [class.border-line]="!isSelected(target.id)"
                    >
                      <span class="flex min-w-0 flex-col gap-0.5">
                        <span class="truncate text-sm font-semibold text-ink">{{ target.label }}</span>
                        @if (target.sublabel) {
                          <span class="text-xs text-muted">{{ target.sublabel }}</span>
                        }
                      </span>
                      <span
                        class="grid size-5 shrink-0 place-items-center rounded-md border transition"
                        [class.border-accent]="isSelected(target.id)"
                        [class.bg-accent]="isSelected(target.id)"
                        [class.border-line]="!isSelected(target.id)"
                        aria-hidden="true"
                      >
                        @if (isSelected(target.id)) {
                          <ng-icon name="lucideCheck" size="14" class="text-panel" />
                        }
                      </span>
                    </button>
                  }
                </div>
              }
            }
            @case ('success') {
              <div class="centered">
                <span class="brand-mark brand-mark--empty brand-pop" aria-hidden="true"></span>
                <p class="title">Conta conectada</p>
                <p appUiHint class="centered-hint">
                  O {{ agentName }}, seu agente de tráfego, já começou a analisar. Você vê o resultado em Contas.
                </p>
              </div>
            }
            @case ('error') {
              <div class="centered">
                <div class="icon icon--error" aria-hidden="true">
                  <ng-icon name="lucideTriangleAlert" size="36" />
                </div>
                <p class="title">Não deu certo</p>
                <p appUiHint class="centered-hint">{{ errorMessage() }}</p>
              </div>
            }
          }
        </div>

        <footer class="actions">
          @switch (step()) {
            @case ('intro') {
              <button appButton variant="ghost" type="button" (click)="cancel()">Cancelar</button>
              <button appButton variant="primary" type="button" (click)="start()">Conectar agora</button>
            }
            @case ('credentials') {
              <button appButton variant="ghost" type="button" (click)="cancel()">Cancelar</button>
              <button appButton variant="primary" type="button" (click)="submitCredentials()" [disabled]="form.invalid">
                {{ credentialForm()?.submitLabel ?? 'Continuar' }}
              </button>
            }
            @case ('connecting') {
              <button appButton variant="ghost" type="button" disabled>Cancelar</button>
              <button appButton variant="primary" type="button" disabled>Conectando…</button>
            }
            @case ('select') {
              <button appButton variant="ghost" type="button" (click)="backToCredentials()">Voltar</button>
              <button
                appButton
                variant="primary"
                type="button"
                (click)="confirmSelection()"
                [disabled]="!hasSelection()"
              >
                Conectar
              </button>
            }
            @case ('success') {
              <button appButton variant="primary" type="button" (click)="finish()">Concluir</button>
            }
            @case ('error') {
              <button appButton variant="ghost" type="button" (click)="cancel()">Fechar</button>
              <button appButton variant="primary" type="button" (click)="retry()">Tentar de novo</button>
            }
          }
        </footer>
      </section>
    </div>
  `,
  styleUrl: './connect-dialog.css',
})
export class ConnectDialogComponent {
  private readonly registry = inject(CONNECTOR_REGISTRY);
  private readonly destroyRef = inject(DestroyRef);

  readonly entry = input.required<ProviderCatalogEntry>();
  readonly closed = output<void>();
  readonly done = output<ConnectDialogDoneEvent>();

  protected readonly agentName = AGENT_NAME;
  protected readonly step = signal<Step>('intro');
  protected readonly errorMessage = signal<string>('');
  protected readonly targets = signal<readonly SelectableTarget[]>([]);
  /** Ids das contas escolhidas (multi-seleção). */
  protected readonly selectedTargetIds = signal<ReadonlySet<string>>(new Set());
  protected readonly hasSelection = computed(() => this.selectedTargetIds().size > 0);
  protected readonly stepDots = STEP_DOTS;

  /** Valores do form guardados p/ reenviar no passo de seleção (token em memória). */
  private submittedValues: Readonly<Record<string, string>> = {};

  protected readonly form = new FormRecord<FormControl<string>>({});

  private readonly strategy = computed(() => resolveConnector(this.registry, this.entry().connectorKey));
  protected readonly credentialForm = computed(() => this.strategy()?.credentialForm ?? null);
  protected readonly stepIndex = computed(() => STEP_INDEX[this.step()]);

  protected readonly introText = computed(
    () => this.strategy()?.introHint ?? `Vamos conectar sua conta ${this.entry().name}.`,
  );
  protected readonly assurances = computed(() => this.strategy()?.assurances ?? []);

  protected isSelected(targetId: string): boolean {
    return this.selectedTargetIds().has(targetId);
  }

  /** Alterna a conta na multi-seleção (checkbox). */
  protected toggleTarget(targetId: string): void {
    const next = new Set(this.selectedTargetIds());
    if (next.has(targetId)) next.delete(targetId);
    else next.add(targetId);
    this.selectedTargetIds.set(next);
  }

  protected start(): void {
    const strategy = this.strategy();
    if (!strategy) {
      this.fail('Nenhum conector configurado para este provedor.');
      return;
    }
    if (strategy.credentialForm && strategy.submitCredentials) {
      this.initCredentialForm();
      this.step.set('credentials');
      return;
    }
    if (!strategy.start) {
      this.fail('Este provedor ainda não pode ser conectado por aqui.');
      return;
    }
    this.step.set('connecting');
    strategy
      .start({ entry: this.entry() })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({ next: (r) => this.applyResult(r), error: () => this.fail() });
  }

  protected submitCredentials(): void {
    const strategy = this.strategy();
    if (!strategy?.submitCredentials || this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }
    this.submittedValues = this.form.getRawValue();
    this.step.set('connecting');
    strategy
      .submitCredentials({ entry: this.entry(), values: this.submittedValues })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({ next: (r) => this.applyResult(r), error: () => this.fail() });
  }

  protected confirmSelection(): void {
    const strategy = this.strategy();
    const targetIds = [...this.selectedTargetIds()];
    if (!strategy?.selectTarget || targetIds.length === 0) {
      return;
    }
    this.step.set('connecting');
    strategy
      .selectTarget({ entry: this.entry(), values: this.submittedValues, targetIds })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({ next: (r) => this.applyResult(r), error: () => this.fail() });
  }

  protected backToCredentials(): void {
    this.errorMessage.set('');
    this.step.set(this.credentialForm() ? 'credentials' : 'intro');
  }

  /** Retry pós-erro: volta à escolha se as contas já foram listadas; senão, ao form. */
  protected retry(): void {
    if (this.targets().length > 0) {
      this.errorMessage.set('');
      this.step.set('select');
      return;
    }
    this.backToCredentials();
  }

  protected cancel(): void {
    this.done.emit({ result: { kind: 'cancelled' } });
    this.closed.emit();
  }

  protected finish(): void {
    this.closed.emit();
  }

  private initCredentialForm(): void {
    for (const key of Object.keys(this.form.controls)) {
      this.form.removeControl(key);
    }
    for (const field of this.credentialForm()?.fields ?? []) {
      this.form.addControl(field.name, new FormControl('', { nonNullable: true, validators: [Validators.required] }));
    }
  }

  private applyResult(result: ConnectResult): void {
    switch (result.kind) {
      case 'success':
        this.step.set('success');
        this.done.emit({ result });
        return;
      case 'select':
        this.targets.set(result.targets);
        this.selectedTargetIds.set(new Set());
        this.step.set('select');
        return;
      case 'cancelled':
        this.cancel();
        return;
      case 'error':
        this.fail(result.message);
        return;
    }
  }

  private fail(message = 'Não consegui concluir agora. Tente de novo.'): void {
    this.errorMessage.set(message);
    this.step.set('error');
  }
}
