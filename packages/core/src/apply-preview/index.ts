// Decide "o que APROVAR faz" (Fatia unificação, diz×faz) — PURO, fonte única da copy (voz do Roy).
// Reusado pelos 3 outputs de aprovação (ação/rascunho/ativação/suggested); o front só renderiza,
// nunca recomputa. `capabilityEnabled` DEVE vir da mesma fonte do apply (resolveEnabledTools).

import type { ApplyPreview } from "@trafego/shared";

/** Prioridade: conta indisponível > trava total > capacidade off > ensaio > real. */
export function computeApplyPreview(input: {
  readonly dryRun: boolean;
  readonly killSwitch: boolean;
  readonly accountAvailable: boolean;
  readonly capabilityEnabled: boolean;
  readonly kind: "action" | "draft" | "activation";
}): ApplyPreview {
  const isCreation = input.kind !== "action";
  if (!input.accountAvailable) {
    return { effect: "blocked", message: "Esta conta está indisponível agora — não dá pra aplicar. Recheque a conexão." };
  }
  if (input.killSwitch) {
    return { effect: "blocked", message: "Trava total ligada — o agente está impedido de agir nesta conta. Desligue em limites de segurança." };
  }
  if (!input.capabilityEnabled) {
    return {
      effect: "blocked",
      message: isCreation
        ? "Criar/duplicar não está habilitado neste agente — habilite em ações permitidas."
        : "Esta ação não está nas ações permitidas deste agente — aprovar não teria efeito. Habilite em ações permitidas.",
    };
  }
  if (input.dryRun) {
    return {
      effect: "simulated",
      message: isCreation
        ? "Modo ensaio ligado — aprovar aqui simula a criação, não cria de verdade."
        : "Modo ensaio ligado — aprovar aqui simula, não altera a conta.",
    };
  }
  return { effect: "real", message: null };
}
