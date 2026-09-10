// Onde mora o orçamento (Gaps 1+2): quando um pedido de budget mira um nível que não tem orçamento
// próprio, o eco genérico ("não consegui simular") não ajuda. Aqui resolvemos ONDE o orçamento de
// fato mora e devolvemos uma oferta/explicação honesta (§13 erro = o quê + próximo passo). NUNCA
// retargeta em silêncio: o orçamento de CBO afeta TODOS os conjuntos da campanha, então é sempre
// OFERTA — o dono decide. As mensagens são PURAS; só o `resolve*` faz o IO (lê o modelo na Meta).

import type { AdsPlatformPort } from "@trafego/shared/ports";
import type { AdAccountRef } from "@trafego/shared/ports";

/** Rótulo "(conta)" só em org multi-conta; string vazia caso contrário. */
export type AccountLabel = string;

/**
 * Gap 2 — anúncio NÃO tem orçamento próprio na Meta: o orçamento fica no conjunto (ABO) ou na
 * campanha (CBO); dentro de um conjunto a Meta distribui a verba entre os anúncios sozinha. Aponta
 * o caminho viável agora (ajustar no conjunto/campanha) e sinaliza o isolamento como possível (a
 * execução do isolamento é fast-follow — não promete clique-e-pronto).
 */
export function adHasNoBudgetMessage(name: string, accountLabel: AccountLabel): string {
  // Enunciado (não pergunta sim/não): num lote misto com um "Confirma?" de outra ação, um "sim"
  // não pode ficar ambíguo entre confirmar a escrita e aceitar esta oferta (§8). O dono re-pede.
  return (
    `No Meta, anúncio não tem orçamento próprio — o orçamento fica no conjunto (ABO) ou na campanha (CBO), ` +
    `e dentro de um conjunto a Meta distribui a verba entre os anúncios automaticamente. ` +
    `Pra mexer no gasto de *${name}*${accountLabel}, é só me pedir pra ajustar o orçamento no conjunto ou na campanha dele. ` +
    `(Pra dar um orçamento só pra esse anúncio, dá pra isolá-lo num conjunto próprio — me avisa que a gente vê isso.)`
  );
}

/**
 * Gap 1 (CBO) — o orçamento do CONJUNTO é gerido na campanha (Advantage/CBO), que vale pra TODOS os
 * conjuntos dela. Oferta ajustar na campanha COM AVISO do blast radius; nunca aplica sozinho.
 */
export function budgetLivesOnCampaignMessage(name: string, accountLabel: AccountLabel): string {
  // Enunciado (não pergunta sim/não) — ver nota em adHasNoBudgetMessage (§8, lote misto).
  return (
    `O orçamento de *${name}*${accountLabel} é gerido na campanha (modelo CBO) — um orçamento único que a Meta ` +
    `distribui entre todos os conjuntos dela, então não dá pra ajustar só esse conjunto. ` +
    `Se quiser, é só me pedir pra ajustar o orçamento da campanha (vale pra todos os conjuntos dela).`
  );
}

/**
 * Gap 1 (ABO) — a CAMPANHA distribui orçamento por conjunto (não tem um orçamento único). Pede qual
 * conjunto ajustar (o dono escolhe; nunca chuta um).
 */
export function budgetLivesOnAdsetsMessage(name: string, accountLabel: AccountLabel): string {
  return (
    `A campanha *${name}*${accountLabel} distribui o orçamento por conjunto (modelo ABO) — ela não tem um ` +
    `orçamento único pra ajustar. Me diz em qual conjunto mexer (posso listar os conjuntos dela pela análise da campanha).`
  );
}

/**
 * Resolve ONDE o orçamento mora quando o nível pedido não tem orçamento próprio, e devolve a
 * mensagem honesta — ou `null` quando não é um caso de nível/tipo (o fluxo normal segue e o
 * dry-run/guardrail dão a mensagem transiente). Só chamado para `adjust_budget` com a leitura fresca
 * já indicando "sem orçamento nesse nível". 1 GET por caso (raro).
 */
export async function resolveMisplacedBudgetMessage(
  ads: AdsPlatformPort,
  account: AdAccountRef,
  level: "campaign" | "adset",
  id: string,
  name: string,
  accountLabel: AccountLabel,
): Promise<string | null> {
  if (level === "adset") {
    // conjunto sem orçamento próprio → provavelmente CBO (orçamento na campanha). Confirma lendo a
    // campanha-mãe; só oferta subir se a campanha de fato tem orçamento.
    const parent = await ads.getAdSetCampaignBudget(account, id);
    if (parent && (parent.dailyBudgetMinor > 0 || parent.lifetimeBudgetMinor > 0)) {
      return budgetLivesOnCampaignMessage(name, accountLabel);
    }
    return null;
  }
  // campanha sem orçamento próprio → ABO (orçamento nos conjuntos). Só é chamado quando a leitura
  // fresca já achou NEM diário NEM vitalício na campanha (budgetByEntity===false) — então a campanha
  // não tem orçamento de nenhum tipo no nível-campanha e é de fato ABO. `getCampaignBudgetLayout` lê
  // só o daily da campanha; `campaignDailyMinor===null` casa com esse contrato (sem orçamento CBO).
  const layout = await ads.getCampaignBudgetLayout(account, id);
  if (layout.campaignDailyMinor === null && layout.adsets.length > 0) {
    return budgetLivesOnAdsetsMessage(name, accountLabel);
  }
  return null;
}
