// Rótulos pt-BR da saúde da conta Meta — ESPELHA ACCOUNT_HEALTH_STATUS_LABELS de
// @trafego/shared (o backend é a fonte da verdade; o web mirror segue o padrão de
// brand.ts/limites de texto — o bundler AOT não resolve runtime de @trafego/shared).
// Status neutro (vocabulário Meta fica no adapter) → copy amigável do resto do app.

const LABELS: Readonly<Record<string, string>> = {
  disabled: "conta desativada, parou de veicular anúncios",
  closed: "conta encerrada",
  pending_closure: "conta em processo de encerramento",
  unsettled: "pagamento pendente",
  pending_settlement: "cobrança pendente",
  grace_period: "pagamento atrasado, conta em período de carência",
  pending_review: "conta em revisão de segurança pela Meta",
  unknown: "status não reconhecido (novo código da Meta)",
};

/** Rótulo da saúde quando NÃO-ativa; null quando ativa/sem dado (nada a mostrar). */
export function accountHealthLabel(status: string | null | undefined): string | null {
  if (!status || status === "active") return null;
  return LABELS[status] ?? null;
}
