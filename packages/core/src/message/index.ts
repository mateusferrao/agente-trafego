// Redação determinística da mensagem de WhatsApp (fallback do redator LLM). PURA
// — WhatsApp-first: curta, 1-decisão-por-bloco (§ decisão 18). O redator LLM (voz
// do arquétipo) é o caminho principal; esta função é a rede quando ele falha.

import { formatMoney } from "@trafego/shared";

export * from "./whatsapp-format.js";
export * from "./enforce-voice.js";

export interface MessageOverview {
  readonly accountName: string;
  /** moeda da conta (ISO) — formata o "money shot" na moeda certa. */
  readonly currency: string;
  /** headline do scorecard (diagnóstico único), quando houver. */
  readonly headline?: string;
  /** resumo em linguagem natural (do analista/síntese). */
  readonly summary: string;
  /** recomendações priorizadas (título curto) — modo FLAT legado (quando não há grupos). */
  readonly recommendations: readonly { readonly title: string }[];
  /** desperdício (§Bloco 2) — abre a mensagem pelo "money shot" quando material. */
  readonly money?: { readonly wastedSpend: number; readonly wastedPct: number };
  // ── Fatia B: agrupamento (detalha TODAS + oferta do que dá pra fazer). Quando qualquer
  //    grupo é fornecido, o fallback rende agrupado (posso fazer / sua direção / observei)
  //    em vez do modo flat. ──
  /** o que o agente CONSEGUE aplicar agora (pendências aprováveis) — lidera com oferta. */
  readonly approvable?: readonly { readonly reason: string; readonly ressalvas?: readonly string[] }[];
  /** direções que o dono aplica manualmente (human_direction). */
  readonly directions?: readonly { readonly title: string }[];
  /** leituras/observações sem ação (insight). */
  readonly observations?: readonly { readonly title: string }[];
}

/** Nº máx. de recomendações listadas na mensagem (WhatsApp-first). */
const DEFAULT_MAX_RECS = 3;

/**
 * Monta a mensagem determinística a partir do resultado curado. Sem URL (o
 * deep-link do site é responsabilidade da casca — core é puro, sem env).
 */
export function buildMessageFallback(overview: MessageOverview, maxRecs = DEFAULT_MAX_RECS): string {
  const lines: string[] = [];
  lines.push(overview.accountName);
  // money shot primeiro (§Bloco 2): o dono quer ver o dinheiro antes do diagnóstico.
  if (overview.money && overview.money.wastedSpend > 0) {
    lines.push(`💸 ${formatMoney(overview.money.wastedSpend, overview.currency)} (${overview.money.wastedPct}%) em campanhas paradas — pausar libera esse valor.`);
  }
  const lead = overview.headline?.trim() || firstSentence(overview.summary);
  if (lead) lines.push(lead);

  // Fatia B: modo AGRUPADO quando há grupos (detalha todas + oferta); senão, flat legado.
  const grouped = overview.approvable !== undefined || overview.directions !== undefined || overview.observations !== undefined;
  if (grouped) {
    appendGroups(lines, overview);
  } else {
    const recs = overview.recommendations.slice(0, maxRecs);
    if (recs.length > 0) {
      lines.push("");
      lines.push("O que sugiro:");
      for (const r of recs) lines.push(`• ${r.title}`);
    }
  }
  return lines.join("\n");
}

/** Renderiza os 3 grupos (Fatia B), cada cabeçalho só quando tem item. */
function appendGroups(lines: string[], o: MessageOverview): void {
  const approvable = o.approvable ?? [];
  if (approvable.length > 0) {
    lines.push("");
    lines.push('Posso fazer agora — responda "pode" (ou aprove no site):');
    for (const a of approvable) {
      const ressalva = a.ressalvas && a.ressalvas.length > 0 ? ` ⚠️ ${a.ressalvas.join("; ")}` : "";
      lines.push(`• ${a.reason}${ressalva}`);
    }
  }
  const directions = o.directions ?? [];
  if (directions.length > 0) {
    lines.push("");
    lines.push("Sua direção (você aplica):");
    for (const d of directions) lines.push(`• ${d.title}`);
  }
  const observations = o.observations ?? [];
  if (observations.length > 0) {
    lines.push("");
    lines.push("Observei:");
    for (const ob of observations) lines.push(`• ${ob.title}`);
  }
}

/** Primeira frase do resumo (evita despejar um parágrafo no WhatsApp). */
function firstSentence(text: string): string {
  const trimmed = text.trim();
  const end = trimmed.search(/[.!?](\s|$)/u);
  return end === -1 ? trimmed : trimmed.slice(0, end + 1);
}
