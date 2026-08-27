import { booleanAttribute, ChangeDetectionStrategy, Component, Input } from '@angular/core';
import { NgIcon } from '@ng-icons/core';

/**
 * Zero-state padronizado. Ícone + título + descrição + slot pra CTA.
 *
 * Uso:
 *   <app-ui-empty-state icon="lucideUsers" title="Nenhum contato" description="Adicione manualmente ou importe um CSV.">
 *     <button appButton variant="primary" actions>Novo contato</button>
 *   </app-ui-empty-state>
 */
@Component({
  selector: 'app-ui-empty-state',
  standalone: true,
  imports: [NgIcon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div [class]="containerClass">
      @if (brand) {
        <!-- Símbolo do agente (tomate) — momento de marca (Roy não tem nada ainda). -->
        <span class="brand-mark brand-mark--empty brand-pop" aria-hidden="true"></span>
      } @else if (icon) {
        <span class="grid size-12 place-items-center rounded-full bg-soft text-muted">
          <ng-icon [name]="icon" size="22" aria-hidden="true" />
        </span>
      }
      <div>
        <p class="text-base font-semibold text-ink">{{ title }}</p>
        @if (description) {
          <p class="mt-1 text-sm text-muted">{{ description }}</p>
        }
      </div>
      <div class="flex items-center gap-2">
        <ng-content select="[actions]" />
      </div>
    </div>
  `,
})
export class UiEmptyStateComponent {
  @Input({ required: true }) title!: string;
  @Input() description?: string;
  @Input() icon?: string;
  /** Usa o símbolo do agente (tomate) no lugar do ícone — momentos de marca (Roy). */
  @Input({ transform: booleanAttribute }) brand = false;
  @Input({ transform: booleanAttribute }) compact = false;

  get containerClass() {
    const density = this.compact ? 'px-4 py-6' : 'px-6 py-10';
    return `mx-auto flex max-w-md flex-col items-center justify-center gap-3 rounded-md border border-dashed border-line/80 bg-soft/30 text-center ${density}`;
  }
}
