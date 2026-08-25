// Transcript AMBIENTE de grupo (read-only) — camada determinística pura entre o dado
// guardado (group_messages ambiente + messages dirigidas/outbound) e o system prompt do
// Grafo B. Injetado SÓ em turno de grupo dirigido; efêmero (nunca vai ao checkpointer).
// PURA: recebe as entradas já mescladas (IO na casca), filtra/ordena/corta/formata.

/** Uma entrada crua do transcript (fonte: ambiente OU dirigida/outbound do grupo). */
export interface GroupTranscriptEntry {
  /** telefone E.164 do autor (null p/ bot ou quando indisponível). */
  readonly authorPhone: string | null;
  /** nome de exibição do autor (pushName). Null → cai no fallback por telefone. */
  readonly authorName: string | null;
  /** texto ou placeholder de mídia ([áudio]/[imagem]/[mídia]). */
  readonly body: string | null;
  /** instante da mensagem (createdAt). */
  readonly at: Date;
  /** true = resposta do próprio bot (outbound) → rotulada com o botLabel. */
  readonly fromBot: boolean;
  /** reply: telefone do autor da mensagem CITADA (null = sem reply). */
  readonly quotedAuthorPhone?: string | null;
  /** reply: trecho da mensagem citada (texto truncado; null p/ mídia/sem reply). */
  readonly quotedSnippet?: string | null;
  /** reply: a mensagem citada é do próprio bot → rotula como o assistente (não telefone). */
  readonly quotedFromBot?: boolean;
}

export interface GroupTranscriptOptions {
  /** "agora" p/ a janela de tempo + o cabeçalho (recência). */
  readonly now: Date;
  /** só entradas das últimas N horas entram. */
  readonly windowHours: number;
  /** teto de mensagens (mantém as mais recentes). */
  readonly maxMessages: number;
  /** teto aproximado de tokens (derruba as mais antigas até caber). */
  readonly maxTokens: number;
  /** rótulo do bot no transcript (persona do agente, senão "Assistente"). */
  readonly botLabel: string;
  /** fuso da org p/ exibir data/hora das mensagens (não UTC). */
  readonly tz: string;
}

/** Aproximação chars→tokens (mesma de window.ts do Grafo B). */
const CHARS_PER_TOKEN = 4;
/** Placeholder quando o corpo veio nulo (defensivo — a casca já resolve mídia). */
const EMPTY_BODY = "[mídia]";

const MS_PER_HOUR = 60 * 60 * 1000;

/** Fallback de atribuição quando não há pushName: "Participante-XXXX" (últimos 4 dígitos). */
function authorLabel(entry: GroupTranscriptEntry, botLabel: string): string {
  if (entry.fromBot) return botLabel;
  if (entry.authorName && entry.authorName.length > 0) return entry.authorName;
  const digits = (entry.authorPhone ?? "").replace(/\D/gu, "");
  return digits.length >= 4 ? `Participante-${digits.slice(-4)}` : "Participante";
}

/** Timestamp curto no fuso `tz`: dd/mm HH:MM. */
function stamp(at: Date, tz: string): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(at);
  const g = (t: string): string => parts.find((p) => p.type === t)?.value ?? "";
  return `${g("day")}/${g("month")} ${g("hour")}:${g("minute")}`;
}

/**
 * Monta o bloco do transcript. Filtra pela janela de tempo, ordena cronologicamente,
 * mantém as últimas `maxMessages` e corta ao teto de tokens (derruba as mais antigas).
 * Retorna "" quando não há nada a mostrar (a casca então não injeta bloco nenhum).
 */
export function buildGroupTranscript(
  entries: readonly GroupTranscriptEntry[],
  opts: GroupTranscriptOptions,
): string {
  const cutoff = opts.now.getTime() - opts.windowHours * MS_PER_HOUR;
  const recent = entries
    .filter((e) => e.at.getTime() >= cutoff && e.at.getTime() <= opts.now.getTime())
    .sort((a, b) => a.at.getTime() - b.at.getTime());

  // últimas N mensagens (mantém as mais recentes).
  let windowed = recent.slice(-opts.maxMessages);

  // mapa telefone→nome (das próprias entradas) p/ rotular o autor citado num reply.
  const nameByPhone = new Map<string, string>();
  for (const e of recent) if (e.authorPhone && e.authorName) nameByPhone.set(e.authorPhone, e.authorName);
  const quotedAuthorLabel = (phone: string | null | undefined): string => {
    if (phone && nameByPhone.has(phone)) return nameByPhone.get(phone)!;
    const digits = (phone ?? "").replace(/\D/gu, "");
    return digits.length >= 4 ? `Participante-${digits.slice(-4)}` : "alguém";
  };
  /** " (↳ resp. a Fulano: "trecho")" quando a mensagem foi reply; "" caso contrário. */
  const replyOf = (e: GroupTranscriptEntry): string => {
    if (!e.quotedAuthorPhone && !e.quotedSnippet && !e.quotedFromBot) return "";
    const who = e.quotedFromBot ? opts.botLabel : quotedAuthorLabel(e.quotedAuthorPhone);
    const snip = e.quotedSnippet && e.quotedSnippet.length > 0 ? `: "${e.quotedSnippet}"` : "";
    return ` (↳ resp. a ${who}${snip})`;
  };

  // formata cada linha e corta ao teto de tokens derrubando as mais antigas.
  const format = (e: GroupTranscriptEntry) =>
    `${authorLabel(e, opts.botLabel)} [${stamp(e.at, opts.tz)}]${replyOf(e)}: ${e.body && e.body.length > 0 ? e.body : EMPTY_BODY}`;
  const maxChars = opts.maxTokens * CHARS_PER_TOKEN;
  let lines = windowed.map(format);
  while (lines.length > 1 && lines.join("\n").length > maxChars) {
    windowed = windowed.slice(1);
    lines = windowed.map(format);
  }
  if (lines.length === 0) return "";

  const header =
    `### Conversa recente do grupo (contexto — NÃO é a mensagem atual; é o que foi dito antes). ` +
    `Agora: ${stamp(opts.now, opts.tz)}.`;
  return `${header}\n${lines.join("\n")}`;
}
