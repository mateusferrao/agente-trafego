import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideTriangleAlert, lucideLock, lucideInfo } from '@ng-icons/lucide';

// Aviso compartilhado dos cards de aprovação (ensaio / bloqueio / ressalva) — ícone por tom +
// role="status" (a11y) + tokens. Fonte ÚNICA: substitui os <span border-warning> inline duplicados
// nas superfícies (approvals, mini-surface). Status = tom + texto (nunca só cor — DESIGN.md).
type Tone = 'warning' | 'blocked' | 'info';
const ICON: Record<Tone, string> = { warning: 'lucideTriangleAlert', blocked: 'lucideLock', info: 'lucideInfo' };
const TONE_CLASS: Record<Tone, string> = {
  warning: 'border-2 border-warning bg-warning-soft text-warning-strong',
  blocked: 'border border-line bg-panel text-ink',
  info: 'border border-line bg-soft text-ink',
};

@Component({
  selector: 'app-ui-callout',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [NgIcon],
  providers: [provideIcons({ lucideTriangleAlert, lucideLock, lucideInfo })],
  template: `<span role="status" class="flex items-start gap-2 rounded-md px-3 py-2 text-xs" [class]="toneClass()">
    <ng-icon [name]="icon()" class="mt-0.5 shrink-0 text-sm" aria-hidden="true" />
    <span class="min-w-0"><ng-content /></span>
  </span>`,
})
export class UiCallout {
  readonly tone = input<Tone>('info');
  protected readonly icon = computed(() => ICON[this.tone()]);
  protected readonly toneClass = computed(() => TONE_CLASS[this.tone()]);
}
