// Núcleo PURO da ativação em cadeia + entrega efetiva (§13: decisão no core, IO na casca).
// A Meta NÃO cascateia status (entrega = campanha ∧ conjunto ∧ anúncio, todos ativos) e o
// `effective_status` só rola pra BAIXO — então "existe anúncio efetivamente ativo" é o predicado
// de entrega inteiro num sinal só. Estas funções operam sobre a `ActivationTree` (já escopada na
// leitura) e são testáveis sem mock.

import type { ActivationNode, ActivationTree } from "@trafego/shared";

/** Descendentes PAUSADOS a religar p/ a subárvore (conjuntos + anúncios) entregar. A `tree` já vem
 *  escopada (campanha → seus filhos; conjunto → seus anúncios), então basta filtrar os pausados. */
export function pausedDescendants(tree: ActivationTree): { adsets: ActivationNode[]; ads: ActivationNode[] } {
  return {
    adsets: tree.adsets.filter((a) => a.status === "paused"),
    ads: tree.ads.filter((a) => a.status === "paused"),
  };
}

/** Motivo pelo qual a campanha não entrega, quando não há anúncio efetivamente ativo. */
export type NonDeliveryReason = "conjuntos pausados" | "anúncios pausados" | "sem anúncio";

/**
 * A campanha ESTÁ entregando? Entrega ⇔ existe anúncio com status efetivo `active` (que já implica
 * campanha + conjunto + anúncio ativos). Quando não, aponta o motivo mais alto na cadeia: sem
 * conjunto ativo → "conjuntos pausados"; conjunto ativo mas nenhum anúncio → "anúncios pausados";
 * sem anúncio nenhum → "sem anúncio". PURA sobre a árvore (a campanha em si já se sabe ativa aqui).
 */
export function campaignDelivering(tree: ActivationTree): { delivering: boolean; reason?: NonDeliveryReason } {
  if (tree.ads.some((a) => a.status === "active")) return { delivering: true };
  if (tree.ads.length === 0) return { delivering: false, reason: "sem anúncio" };
  const hasActiveAdset = tree.adsets.some((a) => a.status === "active");
  return { delivering: false, reason: hasActiveAdset ? "anúncios pausados" : "conjuntos pausados" };
}
