// Núcleo PURO da ativação em cadeia + entrega efetiva (§13: decisão no core, IO na casca).
// A Meta NÃO cascateia status (entrega = campanha ∧ conjunto ∧ anúncio, todos ativos) e o
// `effective_status` só rola pra BAIXO — então "existe anúncio efetivamente ativo" é o predicado
// de entrega inteiro num sinal só. Estas funções operam sobre a `ActivationTree` (já escopada na
// leitura) e são testáveis sem mock.

import type { ActivationNode, ActivationTree } from "@trafego/shared";

/** Descendentes a RELIGAR (pausados no PRÓPRIO nível). Usa o status PRÓPRIO — um filho já ativo no
 *  próprio nível não precisa de ação (o pai pausado o deixa sem entregar, mas religar o pai já
 *  resolve). NÃO usa o efetivo (que rola pra baixo do pai pausado e marcaria a árvore inteira). */
export function pausedDescendants(tree: ActivationTree): { adsets: ActivationNode[]; ads: ActivationNode[] } {
  return {
    adsets: tree.adsets.filter((a) => a.status === "paused"),
    ads: tree.ads.filter((a) => a.status === "paused"),
  };
}

/** Motivo pelo qual a campanha não entrega, quando não há anúncio efetivamente ativo. */
export type NonDeliveryReason = "conjuntos pausados" | "anúncios pausados" | "sem anúncio";

/**
 * A campanha ESTÁ entregando? Entrega ⇔ existe anúncio com status EFETIVO `active` (que já implica
 * campanha + conjunto + anúncio ativos — o efetivo reflete os pais + revisão). Quando não, aponta o
 * motivo mais alto na cadeia. PURA sobre a árvore (usada nas leituras, com a campanha já ativa).
 */
export function campaignDelivering(tree: ActivationTree): { delivering: boolean; reason?: NonDeliveryReason } {
  if (tree.ads.some((a) => a.effectiveStatus === "active")) return { delivering: true };
  if (tree.ads.length === 0) return { delivering: false, reason: "sem anúncio" };
  const hasActiveAdset = tree.adsets.some((a) => a.effectiveStatus === "active");
  return { delivering: false, reason: hasActiveAdset ? "anúncios pausados" : "conjuntos pausados" };
}
