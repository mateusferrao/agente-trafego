import { ChangeDetectionStrategy, Component } from '@angular/core';
import { AGENT_NAME } from '@core/brand';

// Indicador "digitando…" (motif WhatsApp). Usar SÓ em contexto de conversa real
// (o agente compondo uma mensagem), nunca como loader de análise pesada.
@Component({
  selector: 'app-ui-typing-dots',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <span class="ui-typing-dots" role="status" [attr.aria-label]="label">
      <span></span><span></span><span></span>
    </span>
  `,
})
export class UiTypingDots {
  readonly label = `${AGENT_NAME} está digitando`;
}
