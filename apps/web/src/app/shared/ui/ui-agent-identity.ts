import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { AGENT_NAME } from '@core/brand';

// Identidade visual persistente do agente: símbolo tomate + nome fixo (Roy).
// Substitui o ✨ sparkles genérico (regra No Generic AI). Reusa .brand-lockup/.brand-mark.
@Component({
  selector: 'app-ui-agent-identity',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <span class="brand-lockup">
      <span class="brand-mark" aria-hidden="true"></span>
      @if (showName()) {
        <span class="brand-wordmark">{{ name }}</span>
      }
    </span>
  `,
})
export class UiAgentIdentity {
  readonly name = AGENT_NAME;
  // Em contextos onde o nome já aparece ao lado, mostrar só o símbolo.
  readonly showName = input(true);
}
