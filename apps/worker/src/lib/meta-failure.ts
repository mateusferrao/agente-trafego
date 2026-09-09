// Classificação do desfecho de FALHA da Meta na aplicação (criação/ativação/ação). Duas perguntas
// distintas que o worker precisa responder no `catch` (§13 UX: erro = o quê + próximo passo; §7
// honestidade transiente≠determinístico):
//   1. metaUserMessage → texto legível que a Meta escreveu (quando houver), pra transiente.
//   2. permanentMetaReason → a falha é DETERMINÍSTICA (retry não resolve)? Então dá a razão honesta
//      e o chamador RESOLVE (blocked), em vez de deixar pendente convidando um loop de re-tentar o
//      mesmo spec que sempre falha. `null` = transiente (rede/5xx/rate-limit) → mantém "tenta de novo".
// PURO (só inspeciona o erro tipado do port). Testável sem mock.

import { AdsPlatformError } from "@trafego/shared/ports";

/** "A Meta informou: …" quando a plataforma mandou texto legível; senão `undefined`. Nunca vaza o
 *  `message` técnico. Usado no desfecho TRANSIENTE (a permanente usa `permanentMetaReason`). */
export function metaUserMessage(error: unknown): string | undefined {
  return error instanceof AdsPlatformError && error.userMessage ? `A Meta informou: ${error.userMessage.trim()}` : undefined;
}

/**
 * Razão honesta quando a falha é PERMANENTE (a Meta recusou de forma determinística — validação,
 * permissão ou token) — retry do MESMO spec não resolve, então o chamador resolve `blocked` (para o
 * loop) em vez de manter pendente. `null` = transiente (rate-limit/5xx/rede) → o retry/“tenta de novo”
 * segue válido. Não vaza vocabulário do provider (usa só o texto que a plataforma tornou legível).
 */
export function permanentMetaReason(error: unknown): string | null {
  if (!(error instanceof AdsPlatformError)) return null;
  switch (error.kind) {
    case "invalid_credential":
      return "a conexão com a Meta caiu — reconecte o token da conta no site e tente de novo";
    case "not_accessible":
    case "not_duplicable":
      return error.userMessage
        ? friendlyMetaRejection(error.userMessage)
        : "a Meta recusou essa operação (algum dado ficou inválido ou falta permissão na conta) — revise no site ou me peça de outro jeito";
    case "rate_limited":
    case "upstream":
      return null; // transiente — retry pode resolver
  }
}

/**
 * Padrões de recusa determinística que sabemos traduzir pra voz do Roy + próximo passo (§13 UX). Fora
 * dos padrões conhecidos, usa o texto que a Meta tornou legível (o `error_user_msg` é user-facing),
 * enquadrado honesto. B3.
 */
function friendlyMetaRejection(userMessage: string): string {
  const m = userMessage.toLowerCase();
  // Idade × otimização automática (Advantage+ audience): a Meta só aceita a idade como MÍNIMO-sugestão,
  // sem teto. B1 já previne enviando "X+"; se ainda cair aqui, o Roy explica e oferece a correção.
  if (m.includes("idade") && (m.includes("sugest") || m.includes("mínim") || m.includes("minim"))) {
    return "a faixa de idade que você escolheu não combina com a otimização automática da Meta — ela só aceita a idade como um mínimo (sem teto). Me peça pra recriar sem o teto de idade, ou pra desligar a otimização e manter a faixa fixa.";
  }
  return `a Meta recusou: ${userMessage.trim()}`;
}
