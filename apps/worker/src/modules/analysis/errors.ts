// Erros do run de análise + tradução p/ mensagem amigável (§UX: erro = o que
// aconteceu + o que fazer, sem jargão). A casca (agent-runs worker) fecha o run
// como `failed` com esta mensagem no `summary` → o site mostra pro usuário.

import { LLMProviderError } from "@trafego/shared/ports";

export type AnalysisErrorCode =
  | "token_invalid"
  | "agent_missing"
  | "account_missing"
  | "analysis_failed";

export class AnalysisError extends Error {
  constructor(
    readonly code: AnalysisErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "AnalysisError";
  }
}

const FRIENDLY: Record<AnalysisErrorCode, string> = {
  token_invalid:
    "Não consegui acessar sua conta Meta — o token pode ter expirado. Reconecte a conta para analisar de novo.",
  agent_missing: "Não encontrei o agente desta conta. Tente conectar a conta novamente.",
  account_missing: "Não encontrei esta conta. Tente conectá-la novamente.",
  analysis_failed: "Não consegui concluir a análise agora. Tente de novo em instantes.",
};

/** Mensagem amigável p/ o usuário a partir de qualquer erro do run. */
export function friendlyFailureMessage(error: unknown): string {
  if (error instanceof AnalysisError) return FRIENDLY[error.code];
  // erro de LLM (rede/upstream/parse) → mensagem genérica de "tente de novo".
  if (error instanceof LLMProviderError) return FRIENDLY.analysis_failed;
  return FRIENDLY.analysis_failed;
}
