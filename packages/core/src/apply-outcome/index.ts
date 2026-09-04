// Copy ÚNICA do desfecho de uma AÇÃO aplicada (Fatia "depois", diz×faz). Reusada pelo push do
// WhatsApp (apps/worker/approval-apply) E pelo card do site (via API) — mesma voz do Roy nos dois
// canais, num só lugar (§13 reuso-primeiro). PURA (sem IO).

import type { Action } from "@trafego/shared";

/** Detalhe do desfecho — o que o apply-service classificou (com o motivo/mensagem quando há). */
export type OutcomeDetail =
  | { readonly kind: "applied" }
  | { readonly kind: "simulated" }
  | { readonly kind: "noop" }
  | { readonly kind: "blocked"; readonly reason: string }
  | { readonly kind: "failed"; readonly metaMessage?: string };

/** Resumo BREVE (1ª pessoa) do que foi aplicado — voz do Roy, por tipo de ação. */
function appliedActionLine(action: Action): string {
  const name = action.target?.name ?? "a entidade";
  switch (action.type) {
    case "pause_entity":
      return `Pausei ${name}`;
    case "resume_entity":
      return `Reativei ${name}`;
    case "set_status":
      return `Mudei o status de ${name}`;
    case "adjust_budget":
      return `Ajustei o orçamento de ${name}`;
    case "adjust_audience":
      return `Ajustei o público de ${name}`;
    default:
      return `Apliquei a ação em ${name}`;
  }
}

/** Frase de desfecho na voz do Roy (o que aconteceu + próximo passo quando cabe). PURA. */
export function describeActionOutcome(action: Action, detail: OutcomeDetail): string {
  const name = action.target?.name;
  const suffix = name ? ` (${name})` : "";
  switch (detail.kind) {
    case "applied":
      return `${appliedActionLine(action)}.`;
    case "simulated":
      return `Simulei a ação${suffix} (modo ensaio) — mostrei o que faria, sem mexer na conta.`;
    case "noop":
      return `Não precisei mexer${suffix} — já estava no estado desejado.`;
    case "blocked":
      return `Não apliquei${suffix}: ${detail.reason}.`;
    case "failed": {
      if (!detail.metaMessage) return `Não consegui aplicar agora${suffix} — a Meta não respondeu. Tenta de novo em instantes.`;
      // a mensagem da Meta pode não terminar em pontuação → normaliza p/ não emendar na próxima frase.
      const meta = detail.metaMessage.trim();
      const sep = /[.!?]$/.test(meta) ? "" : ".";
      return `${meta}${sep} Dá pra tentar de novo.`;
    }
  }
}
