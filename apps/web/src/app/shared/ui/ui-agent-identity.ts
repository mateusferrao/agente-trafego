import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { AGENT_NAME } from '@core/brand';

export type UiAgentIdentityStatus = 'active' | 'paused';

// Identidade visual persistente do agente: símbolo caqui + nome fixo (Roy).
// Substitui o ✨ sparkles genérico (regra No Generic AI). Reusa .brand-lockup/.brand-mark.
// `status` (opcional) liga o modo "cartão de perfil" (anel de status + linha de status sob
// o nome, vibe Instagram/WhatsApp) — sem ele, é só o lockup simples (mark + nome).
@Component({
  selector: 'app-ui-agent-identity',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <span class="brand-lockup" [class.brand-lockup--profile]="status() !== null">
      @if (status(); as s) {
        <span class="brand-mark-ring" [class.brand-mark-ring--paused]="s === 'paused'" aria-hidden="true">
          <span class="brand-mark"></span>
        </span>
      } @else {
        <span class="brand-mark" aria-hidden="true"></span>
      }
      @if (showName() && status(); as s) {
        <span class="brand-profile-copy">
          <span class="brand-wordmark">{{ name }}</span>
          <span class="brand-profile-status" [class.text-warning-strong]="s === 'paused'" [class.text-success-strong]="s === 'active'">
            {{ s === 'paused' ? 'pausado' : 'ativo nesta conta' }}
          </span>
        </span>
      } @else if (showName()) {
        <span class="brand-wordmark">{{ name }}</span>
      }
    </span>
  `,
})
export class UiAgentIdentity {
  readonly name = AGENT_NAME;
  // Em contextos onde o nome já aparece ao lado, mostrar só o símbolo.
  readonly showName = input(true);
  // null = lockup simples (sem anel/status). 'active'|'paused' = cartão de perfil.
  readonly status = input<UiAgentIdentityStatus | null>(null);
}
