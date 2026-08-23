// Redação determinística da mensagem de WhatsApp (fallback do redator LLM). PURA
// — WhatsApp-first: curta, 1-decisão-por-bloco (§ decisão 18). O redator LLM (voz
// do arquétipo) é o caminho principal; esta função é a rede quando ele falha.

export * from "./whatsapp-format.js";

export interface MessageOverview {
  readonly accountName: string;
  /** headline do scorecard (diagnóstico único), quando houver. */
  readonly headline?: string;
  /** resumo em linguagem natural (do analista/síntese). */
  readonly summary: string;
  /** recomendações priorizadas (título curto). */
  readonly recommendations: readonly { readonly title: string }[];
  /** desperdício (§Bloco 2) — abre a mensagem pelo "money shot" quando material. */
  readonly money?: { readonly wastedSpend: number; readonly wastedPct: number };
}

/** Nº máx. de recomendações listadas na mensagem (WhatsApp-first). */
const DEFAULT_MAX_RECS = 3;

/**
 * Monta a mensagem determinística a partir do resultado curado. Sem URL (o
 * deep-link do site é responsabilidade da casca — core é puro, sem env).
 */
export function buildMessageFallback(overview: MessageOverview, maxRecs = DEFAULT_MAX_RECS): string {
  const lines: string[] = [];
  lines.push(`📊 ${overview.accountName}`);
  // money shot primeiro (§Bloco 2): o dono quer ver o dinheiro antes do diagnóstico.
  if (overview.money && overview.money.wastedSpend > 0) {
    lines.push(`💸 R$${overview.money.wastedSpend} (${overview.money.wastedPct}%) em campanhas paradas — pausar libera esse valor.`);
  }
  const lead = overview.headline?.trim() || firstSentence(overview.summary);
  if (lead) lines.push(lead);

  const recs = overview.recommendations.slice(0, maxRecs);
  if (recs.length > 0) {
    lines.push("");
    lines.push("O que sugiro:");
    for (const r of recs) lines.push(`• ${r.title}`);
  }
  return lines.join("\n");
}

/** Primeira frase do resumo (evita despejar um parágrafo no WhatsApp). */
function firstSentence(text: string): string {
  const trimmed = text.trim();
  const end = trimmed.search(/[.!?](\s|$)/u);
  return end === -1 ? trimmed : trimmed.slice(0, end + 1);
}
