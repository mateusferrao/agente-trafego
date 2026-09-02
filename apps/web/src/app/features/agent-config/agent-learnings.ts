import { ChangeDetectionStrategy, Component, type OnInit, computed, inject, signal } from '@angular/core';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { toast } from 'ngx-sonner';
import { UiBadge, UiButton, UiConfirmDialogService, UiEmptyState, UiSpinner } from '@ui';
import { AnalysisApiService } from '@core/api/analysis-api.service';
import { LearningsApiService } from '@core/api/learnings-api.service';
import { AGENT_NAME } from '@core/brand';
import type { LearningsList } from '@core/api/generated';

type Learning = LearningsList['items'][number];
type Opportunity = LearningsList['opportunities'][number];

/** Selo de confiança → tom+texto (nunca só cor — §UX). */
const TIER_TONE: Record<Learning['tier'], 'neutral' | 'info' | 'success'> = {
  explorando: 'neutral',
  provavel: 'info',
  confirmado: 'success',
};
const TIER_LABEL: Record<Learning['tier'], string> = {
  explorando: 'Explorando',
  provavel: 'Provável',
  confirmado: 'Confirmado',
};
/** Origem em linguagem de gente (traduz o enum técnico). */
const ORIGIN_LABEL: Record<Learning['origin'], string> = {
  our_action: 'a partir de uma ação aplicada',
  observational: 'observando sua conta',
  human_feedback: 'do seu feedback',
  human_manual: 'de uma mudança que você fez',
};

/**
 * Aba "Aprendizados" — aba própria do detalhe da conta (entre "Agente" e "Criativos"). Quatro
 * zonas CONDICIONAIS (só aparece o que existe): (1) "Precisam de você" = propostas de ajuste
 * (aprovar/rejeitar); (2) "Oportunidades" = aviso de teto (ajustar nas config / dispensar);
 * (3) "O que o agente já sabe" = priors ativos (confirmar/esquecer; ajuste aplicado → reverter);
 * (4) "Arquivados" = recolhido, com busca + restaurar. Cópia didática distingue os 3 tipos.
 * Rota `accounts/:id/aprendizados` — o agente é resolvido do accountId (mesmo padrão das abas irmãs).
 */
@Component({
  selector: 'app-agent-learnings',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [UiBadge, UiButton, UiEmptyState, UiSpinner, RouterLink],
  template: `
    <div class="flex flex-col gap-4">
      @if (loading()) {
        <section class="rounded-lg border border-line bg-panel p-5">
          <div class="flex items-center gap-2 text-sm text-muted"><app-ui-spinner /> Carregando aprendizados…</div>
        </section>
      } @else if (failed()) {
        <section class="rounded-lg border border-line bg-panel p-5">
          <p class="text-sm text-muted">
            Não consegui carregar os aprendizados agora.
            <button type="button" appButton size="sm" variant="secondary" (click)="reload()">Tentar de novo</button>
          </p>
        </section>
      } @else {
        <!-- (1) Precisam de você: propostas de ajuste de comportamento (aprova → afina a análise) -->
        @if (needsYou().length > 0) {
          <section class="flex flex-col gap-3 rounded-lg border border-accent/50 bg-accent-soft/30 p-5">
            <div>
              <h2 class="font-brand text-base font-semibold text-ink">Precisam de você</h2>
              <p class="mt-1 text-xs text-muted">
                {{ agentName }} tem provas suficientes pra sugerir um ajuste de comportamento. Aprovar afina a
                análise (nunca muda seus limites de segurança) e é reversível.
              </p>
            </div>
            @for (l of needsYou(); track l.id) {
              <div class="flex flex-col gap-2 rounded-md border border-line/60 bg-panel p-4">
                <p class="text-sm text-ink">{{ l.content }}</p>
                <p class="text-xs text-muted">Ajuste proposto: {{ agentName }} pode {{ l.proposedBehavior }}.</p>
                <div class="flex flex-wrap gap-2 pt-1">
                  <button type="button" appButton size="sm" variant="primary" [disabled]="busy()" (click)="acceptThreshold(l)">Sim, ajustar</button>
                  <button type="button" appButton size="sm" variant="ghost" [disabled]="busy()" (click)="rejectProposal(l)">Agora não</button>
                </div>
              </div>
            }
          </section>
        }

        <!-- (2) Oportunidades: aviso de teto vivo (só aponta pra config — nunca muda nada sozinho) -->
        @if (opportunities().length > 0) {
          <section class="flex flex-col gap-3 rounded-lg border border-line bg-panel p-5">
            <div>
              <h2 class="font-brand text-base font-semibold text-ink">Oportunidades</h2>
              <p class="mt-1 text-xs text-muted">
                Um limite de segurança pode estar segurando ganho. {{ agentName }} só aponta — quem decide é você,
                nas configurações.
              </p>
            </div>
            @for (o of opportunities(); track o.key) {
              <div class="flex flex-col gap-2 rounded-md border border-line/60 bg-soft/40 p-4">
                <p class="text-sm text-ink">
                  Seu teto de aumento de verba hoje é {{ o.cappedPct }}%, mas a análise quis {{ o.wantedPct }}% numa
                  campanha que a conta indica que compensaria — cerca de R$ {{ major(o) }} por dia segurados.
                </p>
                <div class="flex flex-wrap gap-2 pt-1">
                  <a appButton size="sm" variant="secondary" [routerLink]="['/accounts', accountId, 'agente']">Ajustar nas configurações →</a>
                  <button type="button" appButton size="sm" variant="ghost" [disabled]="busy()" (click)="dismissOpportunity()">Dispensar</button>
                </div>
              </div>
            }
          </section>
        }

        <!-- (3) O que o agente já sabe: priors ativos -->
        <section class="flex flex-col gap-4 rounded-lg border border-line bg-panel p-5">
          <div>
            <h2 class="font-brand text-base font-semibold text-ink">O que o agente já sabe</h2>
            <p class="mt-1 text-xs text-muted">
              Padrões que {{ agentName }} vem notando nesta conta. Os <span class="text-ink">confirmados</span> já
              pesam no diagnóstico; os que ainda estão <span class="text-ink">em teste</span> ele acompanha com cautela.
            </p>
          </div>

          @if (knows().length === 0) {
            <app-ui-empty-state
              brand
              title="Ainda estou conhecendo esta conta"
              [description]="'Conforme ' + agentName + ' acompanha os resultados, os padrões que ele perceber aparecem aqui. Não precisa fazer nada — é automático.'"
            />
          } @else {
            <ul class="flex flex-col gap-3">
              @for (l of knows(); track l.id) {
                <li class="flex flex-col gap-2 rounded-md border border-line/60 bg-soft/40 p-4">
                  @if (editingId() === l.id) {
                    <textarea
                      class="w-full rounded-md border border-line bg-panel p-2 text-sm text-ink"
                      rows="2"
                      [value]="editText()"
                      (input)="editText.set($any($event.target).value)"
                    ></textarea>
                    <div class="flex gap-2">
                      <button type="button" appButton size="sm" variant="primary" [disabled]="busy()" (click)="saveEdit(l)">Salvar</button>
                      <button type="button" appButton size="sm" variant="ghost" [disabled]="busy()" (click)="cancelEdit()">Cancelar</button>
                    </div>
                  } @else {
                    <p class="text-sm text-ink">{{ l.content }}</p>
                    <div class="flex flex-wrap items-center gap-2 text-[11px] text-muted">
                      <span appBadge [tone]="tierTone(l)" size="xs">{{ tierLabel(l) }}</span>
                      <span>{{ originLabel(l) }}</span>
                      @if (l.reinforceCount > 0) {
                        <span>· visto {{ l.reinforceCount + 1 }}×</span>
                      }
                      @if (l.lifecycle === 'stale') {
                        <span appBadge tone="neutral" size="xs">desbotando</span>
                      }
                    </div>
                    @if (l.appliedBehavior) {
                      <p class="text-[11px] text-muted">
                        Ajuste aplicado ({{ l.appliedBehavior }}).
                        <button type="button" class="text-ink underline" [disabled]="busy()" (click)="revertThreshold(l)">Reverter</button>
                      </p>
                    }
                    <div class="flex flex-wrap gap-2 pt-1">
                      @if (!l.confirmedByHuman) {
                        <button type="button" appButton size="sm" variant="secondary" [disabled]="busy()" (click)="confirm(l)">É isso mesmo</button>
                      }
                      <button type="button" appButton size="sm" variant="ghost" [disabled]="busy()" (click)="startEdit(l)">Editar</button>
                      <button type="button" appButton size="sm" variant="ghost" [disabled]="busy()" (click)="forget(l)">Esquecer</button>
                    </div>
                  }
                </li>
              }
            </ul>
          }
        </section>

        <!-- (4) Arquivados: recolhido, com busca + restaurar -->
        @if (archived().length > 0) {
          <section class="flex flex-col gap-3 rounded-lg border border-line bg-panel p-5">
            <button type="button" class="flex items-center justify-between text-left" (click)="showArchived.set(!showArchived())">
              <h2 class="font-brand text-base font-semibold text-ink">Arquivados ({{ archived().length }})</h2>
              <span class="text-xs text-muted">{{ showArchived() ? 'ocultar' : 'mostrar' }}</span>
            </button>
            @if (showArchived()) {
              <input
                type="search"
                class="w-full rounded-md border border-line bg-soft/40 p-2 text-sm text-ink"
                placeholder="Buscar nos arquivados…"
                [value]="archivedQuery()"
                (input)="archivedQuery.set($any($event.target).value)"
              />
              @if (filteredArchived().length === 0) {
                <p class="text-xs text-muted">Nenhum aprendizado arquivado corresponde à busca.</p>
              } @else {
                <ul class="flex flex-col gap-2">
                  @for (l of filteredArchived(); track l.id) {
                    <li class="flex items-center justify-between gap-3 rounded-md border border-line/50 bg-soft/30 p-3">
                      <p class="text-sm text-muted">{{ l.content }}</p>
                      <button type="button" appButton size="sm" variant="ghost" [disabled]="busy()" (click)="restore(l)">Restaurar</button>
                    </li>
                  }
                </ul>
              }
            }
          </section>
        }
      }
    </div>
  `,
})
export class AgentLearnings implements OnInit {
  private readonly analysisApi = inject(AnalysisApiService);
  private readonly learningsApi = inject(LearningsApiService);
  private readonly confirmDialog = inject(UiConfirmDialogService);
  private readonly route = inject(ActivatedRoute);

  protected readonly accountId = this.route.snapshot.paramMap.get('id') ?? '';

  protected readonly agentName = AGENT_NAME;
  protected readonly loading = signal(true);
  protected readonly failed = signal(false);
  protected readonly busy = signal(false);
  protected readonly items = signal<Learning[]>([]);
  protected readonly opportunities = signal<Opportunity[]>([]);
  protected readonly archived = signal<Learning[]>([]);
  private readonly agentId = signal<string | null>(null);
  protected readonly editingId = signal<string | null>(null);
  protected readonly editText = signal('');
  protected readonly showArchived = signal(false);
  protected readonly archivedQuery = signal('');

  // Zona 1 = priors com proposta pendente; zona 3 = os demais (priors ativos).
  protected readonly needsYou = computed(() => this.items().filter((l) => !!l.proposedBehavior));
  protected readonly knows = computed(() => this.items().filter((l) => !l.proposedBehavior));
  protected readonly filteredArchived = computed(() => {
    const q = this.archivedQuery().trim().toLowerCase();
    return q ? this.archived().filter((l) => l.content.toLowerCase().includes(q)) : this.archived();
  });

  ngOnInit(): void {
    this.reload();
  }

  protected reload(): void {
    this.loading.set(true);
    this.failed.set(false);
    this.analysisApi.getAgent(this.accountId, { silent: true }).subscribe({
      next: (agent) => {
        this.agentId.set(agent.agentId);
        this.loadLessons(agent.agentId);
      },
      error: () => this.fail(),
    });
  }

  private loadLessons(agentId: string): void {
    this.learningsApi.list(agentId, { silent: true }).subscribe({
      next: (out) => {
        this.items.set(out.items);
        this.opportunities.set(out.opportunities);
        this.archived.set(out.archived);
        this.loading.set(false);
      },
      error: () => this.fail(),
    });
  }

  private fail(): void {
    this.failed.set(true);
    this.loading.set(false);
  }

  /** Envolve uma mutação: guarda `busy`, toast, recarrega. */
  private async run(action: (id: string) => Promise<unknown>, okMsg: string): Promise<void> {
    const id = this.agentId();
    if (!id || this.busy()) return;
    this.busy.set(true);
    try {
      await action(id);
      toast.success(okMsg);
      this.loadLessons(id);
    } finally {
      this.busy.set(false);
    }
  }

  protected confirm(l: Learning): Promise<void> {
    return this.run((id) => firstValueFrom(this.learningsApi.confirm(id, l.id)), 'aprendizado confirmado');
  }

  protected async forget(l: Learning): Promise<void> {
    const ok = await this.confirmDialog.confirm({
      title: 'Esquecer este aprendizado?',
      description: 'O agente para de considerar isso. Você pode restaurar depois, nos arquivados.',
      confirmLabel: 'Esquecer',
      cancelLabel: 'Manter',
      tone: 'danger',
    });
    if (!ok) return;
    return this.run((id) => firstValueFrom(this.learningsApi.forget(id, l.id)), 'aprendizado esquecido');
  }

  protected restore(l: Learning): Promise<void> {
    return this.run((id) => firstValueFrom(this.learningsApi.restore(id, l.id)), 'aprendizado restaurado');
  }

  protected acceptThreshold(l: Learning): Promise<void> {
    return this.run((id) => firstValueFrom(this.learningsApi.acceptThreshold(id, l.id)), 'comportamento ajustado');
  }

  protected rejectProposal(l: Learning): Promise<void> {
    return this.run((id) => firstValueFrom(this.learningsApi.rejectProposal(id, l.id)), 'proposta dispensada');
  }

  protected revertThreshold(l: Learning): Promise<void> {
    return this.run((id) => firstValueFrom(this.learningsApi.revertThreshold(id, l.id)), 'ajuste revertido');
  }

  protected dismissOpportunity(): Promise<void> {
    return this.run((id) => firstValueFrom(this.learningsApi.dismissOpportunity(id)), 'aviso dispensado');
  }

  protected startEdit(l: Learning): void {
    this.editingId.set(l.id);
    this.editText.set(l.content);
  }
  protected cancelEdit(): void {
    this.editingId.set(null);
  }
  protected async saveEdit(l: Learning): Promise<void> {
    const content = this.editText().trim();
    if (content.length === 0) return;
    await this.run(async (id) => {
      await firstValueFrom(this.learningsApi.edit(id, l.id, { content }));
      this.editingId.set(null);
    }, 'aprendizado atualizado');
  }

  /** R$ (major) do valor bloqueado pelo teto — foregoneMinor é a unidade MENOR da moeda. */
  protected major(o: Opportunity): string {
    return (o.foregoneMinor / 100).toLocaleString('pt-BR', { maximumFractionDigits: 0 });
  }

  protected tierTone(l: Learning): 'neutral' | 'info' | 'success' {
    return TIER_TONE[l.tier];
  }
  protected tierLabel(l: Learning): string {
    return TIER_LABEL[l.tier];
  }
  protected originLabel(l: Learning): string {
    return ORIGIN_LABEL[l.origin];
  }
}
