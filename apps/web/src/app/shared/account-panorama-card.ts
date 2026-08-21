// Card de conta (panorama) — decisão/resultado: nota datada + KPIs ao vivo + as-of +
// Atualizar. Presentacional; compartilhado pelo Painel (resumo top-N) e por Contas
// (lista completa). Só design tokens.

import { ChangeDetectionStrategy, Component, input, output } from "@angular/core";
import { RouterLink } from "@angular/router";
import { NgIcon, provideIcons } from "@ng-icons/core";
import { heroArrowPath } from "@ng-icons/heroicons/outline";
import { UiBadge, UiButton } from "@ui";
import type { PanoramaListOutput } from "@core/api/generated";
import { asOfLabel, gradeTone, money, timeLabel } from "./format";

export type PanoramaCardVm = PanoramaListOutput["accounts"][number];

@Component({
  selector: "app-account-panorama-card",
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, NgIcon, UiBadge, UiButton],
  providers: [provideIcons({ heroArrowPath })],
  template: `
    @let c = card();
    <!-- Card inteiro clicável: o link do nome estica sobre o card (::after); o botão
         Atualizar fica acima (z-10) p/ não disparar a navegação. -->
    <div class="relative flex flex-col gap-2 rounded-lg border border-line bg-panel p-4 transition hover:border-accent/40">
      <div class="flex items-start justify-between gap-2">
        <a
          [routerLink]="['/accounts', c.accountId]"
          class="text-sm font-semibold text-ink after:absolute after:inset-0 after:content-[''] hover:text-accent-strong"
        >
          {{ c.accountName }}
        </a>
        @if (c.grade) {
          <div class="flex flex-col items-end gap-0.5">
            <span appBadge [tone]="gradeTone(c.grade)" size="sm">Nota {{ c.grade }}</span>
            @if (c.gradeAsOf) {
              <span class="text-[10px] text-muted">análise {{ timeLabel(c.gradeAsOf) }}</span>
            }
          </div>
        }
      </div>
      @if (c.live; as t) {
        <div class="flex flex-wrap items-baseline gap-x-4 gap-y-1">
          <span class="text-base font-semibold text-ink">{{ money(t.spend, c.currency) }}</span>
          @if (t.cpa !== undefined) {
            <span class="text-xs text-muted">CPA {{ money(t.cpa, c.currency) }}</span>
          }
        </div>
      } @else {
        <span class="text-xs text-muted">sem dados na janela</span>
      }
      @if (c.tokenStatus === 'invalid') {
        <span class="text-xs text-danger-strong">Token expirado — reconecte em Integrações.</span>
      } @else if (c.agentPaused) {
        <span class="text-xs text-warning-strong">Agente pausado — números não atualizam sozinhos.</span>
      }
      <div class="mt-1 flex items-center justify-between gap-2">
        <span class="text-xs" [class.text-muted]="!c.stale" [class.text-warning-strong]="c.stale">
          {{ asOfLabel(c.asOf, c.stale) }}
        </span>
        <button appButton variant="secondary" type="button" class="relative z-10" [disabled]="refreshing()" (click)="refresh.emit(c.accountId)">
          <ng-icon name="heroArrowPath" size="14" aria-hidden="true" [class.animate-spin]="refreshing()" />
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
  protected readonly gradeTone = gradeTone;
  protected readonly timeLabel = timeLabel;
}
