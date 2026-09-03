// Seam de PASSES de revisão (Fatia E3) — a rede de segurança do `review_analysis` deixa de ser UMA
// chamada hardcoded e vira uma LISTA de passes, aplicados em sequência (cada um refina a saída do
// anterior). Hoje há UM passe (editor-chefe); a costura permite crescer p/ os painéis especialistas
// da Fatia 8 (revisor de escala/tracking/desperdício + redator + validador de ação) SEM reescrever o
// grafo — só registrar mais passes aqui. Invariante do revisor preservada: refina/corta, nunca inventa.

import type { AccountBrief } from "@trafego/shared";
import type { AnalysisOutput } from "@trafego/shared/schemas";
import type { LLMMessage } from "@trafego/shared/ports";
import type { FindingIssue } from "@trafego/core";
import { buildReviewMessages } from "./prompt.js";

/** Um passe de revisão: monta as mensagens LLM a partir do rascunho ATUAL (o que o passe anterior
 *  deixou). `key` identifica o passe no metering/trace. */
export interface ReviewPass {
  readonly key: string;
  readonly buildMessages: (
    brief: AccountBrief,
    draft: AnalysisOutput,
    issues: readonly FindingIssue[],
    vertical?: string,
  ) => LLMMessage[];
}

/**
 * Lista DEFAULT de passes — hoje só o editor-chefe (comportamento idêntico ao revisor único de
 * antes). Fatia 8 acrescenta passes especialistas aqui (ou via config quando houver mais de um).
 */
export const DEFAULT_REVIEW_PASSES: readonly ReviewPass[] = [
  { key: "chief_editor", buildMessages: buildReviewMessages },
];
