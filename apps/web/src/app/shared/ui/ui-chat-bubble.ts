import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

// Balão de chat (motif WhatsApp) para previews de conversa/timeline.
// from='agent' (menta) | 'user' (painel + borda).
@Component({
  selector: 'app-ui-chat-bubble',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '[class]': 'classes()' },
  template: `<ng-content />`,
})
export class UiChatBubble {
  readonly from = input<'agent' | 'user'>('agent');
  readonly classes = computed(() => `ui-chat-bubble ui-chat-bubble--${this.from()}`);
}
