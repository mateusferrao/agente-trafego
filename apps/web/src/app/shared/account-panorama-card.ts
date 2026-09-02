// Card de conta (panorama) — decisão/resultado: nota datada + KPIs ao vivo + as-of +
// Atualizar. Presentacional; compartilhado pelo Painel (resumo top-N) e por Contas
// (lista completa). Só design tokens.

import { ChangeDetectionStrategy, Component, input, output } from "@angular/core";
import { RouterLink } from "@angular/router";
import { NgIcon, provideIcons } from "@ng-icons/core";
import { lucideRefreshCw } from "@ng-icons/lucide";
import { UiButton, UiEyebrow } from "@ui";
import type { PanoramaListOutput } from "@core/api/generated";
import { asOfLabel, dateTimeLabel, money } from "./format";
import { accountHealthLabel } from "./account-health-labels";

export type PanoramaCardVm = PanoramaListOutput["accounts"][number];

type Grade = NonNullable<PanoramaCardVm["grade"]>;
/** Nota → palavra de saúde (aposenta a nota-letra escolar). */
const GRADE_WORD: Record<Grade, string> = { A: "ótimo", B: "bom", C: "atenção", D: "crítico" };
const GRADE_TEXT: Record<Grade, string> = {
  A: "text-success-strong",
  B: "text-info-strong",
  C: "text-warning-strong",
  D: "text-danger-strong",
};

@Component({
  selector: "app-account-panorama-card",
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, NgIcon, UiButton, UiEyebrow],
  providers: [provideIcons({ lucideRefreshCw })],
  // host ocupa a célula inteira do grid (align stretch) → todos os cards da linha
  // ficam com a MESMA altura, mesmo sem dado de gasto (footer alinhado por mt-auto).
  host: { class: "block h-full" },
  template: `
    @let c = card();
    <!-- Card inteiro clicável: o link do nome estica sobre o card (::after); o botão
         Atualizar fica acima (z-10) p/ não disparar a navegação. h-full = altura uniforme. -->
    <div
      class="ui-panel-card--brand relative flex h-full flex-col gap-2 transition hover:border-accent motion-safe:hover:-translate-y-0.5"
    >
      <div class="flex items-start justify-between gap-2">
        <a
          [routerLink]="['/accounts', c.accountId]"
          class="text-sm font-semibold text-ink after:absolute after:inset-0 after:content-[''] hover:text-accent-strong"
        >
          {{ c.accountName }}
        </a>
        @if (c.grade) {
          <div class="flex flex-col items-end gap-0.5">
            <app-ui-eyebrow [class]="gradeText(c.grade)">{{ gradeWord(c.grade) }}</app-ui-eyebrow>
            @if (c.gradeAsOf) {
              <span class="text-[10px] text-muted">análise {{ dateTimeLabel(c.gradeAsOf) }}</span>
            }
          </div>
        }
      </div>
      @if (c.live; as t) {
        <div class="flex flex-wrap items-baseline gap-x-4 gap-y-1">
          <span class="ui-stat__value text-lg text-ink">{{ money(t.spend, c.currency) }}</span>
          @if (t.cpa !== undefined) {
            <span class="flex items-baseline gap-1"><app-ui-eyebrow>CPA</app-ui-eyebrow><b class="ui-stat__value text-xs text-ink">{{ money(t.cpa, c.currency) }}</b></span>
          }
        </div>
      } @else if (c.dormant) {
        <span class="text-xs text-warning-strong">conta parada — vigiando o retorno</span>
      } @else {
        <span class="text-xs text-muted">sem gasto no período</span>
      }
      @if (accountHealthLabel(c); as label) {
        <span class="text-xs text-danger-strong">Conta Meta: {{ label }}.</span>
      }
      @if (c.tokenStatus === 'invalid') {
        <span class="text-xs text-danger-strong">Token expirado — reconecte em Integrações.</span>
      } @else if (c.agentPaused) {
        <span class="text-xs text-warning-strong">
          Agente pausado. Atualize aqui ou reative o agente para os números voltarem a atualizar sozinhos.
        </span>
      }
      <!-- mt-auto empurra o rodapé pra base → footer alinhado em todos os cards da linha. -->
      <div class="mt-auto flex items-center justify-between gap-2 pt-1">
        <span class="text-xs" [class.text-muted]="!c.stale" [class.text-warning-strong]="c.stale">
          {{ asOfLabel(c.asOf, c.stale) }}
        </span>
        <button appButton variant="secondary" type="button" class="relative z-10" [disabled]="refreshing()" (click)="refresh.emit(c.accountId)">
          <ng-icon name="lucideRefreshCw" size="14" aria-hidden="true" [class.animate-spin]="refreshing()" />
          Atualizar
        </button>
      </div>
    </div>
  `,
})
export class AccountPanoramaCard {
  readonly card = input.required<PanoramaCardVm>();
  readonly refreshing = input<boolean>(false);
  readonly refresh = output<string>();

  protected readonly money = money;
  protected readonly asOfLabel = asOfLabel;
  protected readonly dateTimeLabel = dateTimeLabel;
  protected gradeWord(g: Grade): string {
    return GRADE_WORD[g];
  }
  protected gradeText(g: Grade): string {
    return GRADE_TEXT[g];
  }
  /** Rótulo da saúde da conta Meta quando NÃO-ativa (badge no roster); null = ok/sem dado. */
  protected accountHealthLabel(c: PanoramaCardVm): string | null {
    return accountHealthLabel(c.accountHealthStatus);
  }
}
