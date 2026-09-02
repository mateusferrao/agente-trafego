// Resumo compacto (PT) de um rascunho de campanha — reusado pelo push assíncrono do apply-service
// (approval-apply.ts) E pelo list_pending do chat (read-data.ts, P0.1): os dois precisam dizer
// "o que" foi criado/vai ser ativado sem duplicar a formatação.

import { goalNounPt } from "@trafego/core";
import type { CampaignDraftSpec, DraftKind } from "@trafego/shared";

/** "uma campanha de vendas, R$ 50,00/dia · 2 variação(ões) de copy" ou "a duplicata do seu
 *  vencedor, R$ 80,00/dia". Sem jargão técnico (§UX) — o objetivo em PT, valor formatado na moeda. */
export function describeCreatedDraft(kind: DraftKind, spec: CampaignDraftSpec): string {
  const money = new Intl.NumberFormat("pt-BR", { style: "currency", currency: spec.currency }).format(spec.dailyBudgetMinor / 100);
  if (kind === "duplicate") return `a duplicata do seu vencedor, ${money}/dia`;
  const goal = spec.objective ? goalNounPt(spec.objective) : "campanha";
  const variants = spec.copyVariants?.length ?? 0;
  return `uma campanha de ${goal}, ${money}/dia${variants > 0 ? ` · ${variants} variação(ões) de copy` : ""}`;
}
