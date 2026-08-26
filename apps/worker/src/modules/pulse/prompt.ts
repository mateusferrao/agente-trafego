// Redator do PULSO (P2 — "resumo do dia"): voz + postura sobre um retrato FRESCO da
// janela "ontem fechado + hoje até agora" (getFreshMetricsData) + recomendações que
// seguem valendo do último run. Honesto sobre a atribuição intradiária. LLM barato;
// fallback determinístico. Distinto do redator de análise (não recebe AnalysisOutput).

import type { LLMMessage } from "@trafego/shared/ports";
import type { Posture } from "@trafego/shared";
import { formatMoney } from "@trafego/shared";
import { composePostureBlock } from "@trafego/core";
import { GROUNDING_RULE } from "../analysis/prompt.js";
import type { FreshKpis } from "../conversation/fresh-metrics.js";

/** Structured output do pulso — um único campo de texto (igual ao redator de análise). */
export const PULSE_OUTPUT_JSON_SCHEMA: Readonly<Record<string, unknown>> = {
  type: "object",
  properties: { text: { type: "string" } },
  required: ["text"],
  additionalProperties: false,
};
export const PULSE_OUTPUT_SCHEMA_NAME = "pulse_message";

/** Rótulo fixo do período do pulso (a janela é sempre ontem+hoje, independe da hora). */
export const PULSE_PERIOD_LABEL = "ontem (fechado) + hoje até agora";

const PULSE_VOICE_RULES = [
  "Escreva um RESUMO DO DIA curto pro dono da conta no WhatsApp.",
  `Deixe claro o período: ${PULSE_PERIOD_LABEL}.`,
  "Os números de HOJE ainda estão consolidando (a atribuição da Meta atrasa) — ressalve isso ao citar hoje.",
  "Lidere pelo que importa: gasto, resultado (custo por conversão) e a variação vs o período anterior quando houver.",
  "Se houver recomendações que SEGUEM VALENDO da última análise, cite as principais como próximo passo.",
  "Se 'updated' for false, diga que está mostrando o último dado sincronizado (não deu pra atualizar agora).",
  "Não invente números nem ações: use SOMENTE o que está no resultado fornecido.",
].join(" ");

/** Insumo curado do pulso (fresco + recs que seguem valendo). */
export interface PulseInput {
  readonly accountName: string;
  /** moeda da conta (ISO) — formatação dos valores. */
  readonly currency: string;
  readonly kpis: FreshKpis;
  readonly updated: boolean;
  /** variação % de gasto vs o período anterior (null = sem base). */
  readonly spendDeltaPct: number | null;
  /** rótulo do CPA derivado da conversão de negócio ("Custo por venda"…). */
  readonly cpaLabel: string;
  /** recomendações que seguem valendo do último run (já capadas pelo volume). */
  readonly standingRecs: readonly string[];
  /** true = não há análise concluída (conta nova) → orienta rodar uma análise. */
  readonly noAnalysisYet: boolean;
}

function money(n: number | null | undefined, currency: string): string {
  return typeof n === "number" ? formatMoney(n, currency) : "—";
}

/** Curadoria dos KPIs frescos p/ o prompt (só o material). */
function curateKpis(k: FreshKpis): Record<string, unknown> {
  return {
    spend: k.spend,
    ...(k.conversions != null ? { conversions: k.conversions } : {}),
    ...(k.cpa != null ? { cpa: k.cpa } : {}),
    ...(k.roas != null ? { roas: k.roas } : {}),
    ...(k.ctr != null ? { ctr: k.ctr } : {}),
  };
}

/** Monta as mensagens do redator do pulso. `systemPrompt` = voz do agente (composeAgentVoice). */
export function buildPulseMessages(systemPrompt: string, posture: Posture, input: PulseInput): LLMMessage[] {
  const system = [systemPrompt, composePostureBlock(posture), PULSE_VOICE_RULES, GROUNDING_RULE].join("\n\n");
  const curated = {
    accountName: input.accountName,
    currency: input.currency,
    period: PULSE_PERIOD_LABEL,
    updated: input.updated,
    cpaLabel: input.cpaLabel,
    kpis: curateKpis(input.kpis),
    ...(input.spendDeltaPct != null ? { spendDeltaPct: input.spendDeltaPct } : {}),
    ...(input.standingRecs.length > 0 ? { standingRecommendations: input.standingRecs } : {}),
    ...(input.noAnalysisYet ? { noAnalysisYet: true } : {}),
  };
  const user = [
    "Retrato do dia (base do resumo):",
    "```json",
    JSON.stringify(curated),
    "```",
    "",
    'Responda SOMENTE com JSON no formato { "text": "..." } — o texto pronto p/ enviar no WhatsApp.',
  ].join("\n");
  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}

/** Fallback determinístico do pulso (LLM fora / erro) — período + números + próximos passos. */
export function buildPulseFallback(input: PulseInput): string {
  const lines: string[] = [`📊 ${input.accountName} — resumo do dia (${PULSE_PERIOD_LABEL})`];
  const k = input.kpis;
  const bits = [`gasto ${money(k.spend, input.currency)}`];
  if (k.cpa != null) bits.push(`${input.cpaLabel.toLowerCase()} ${money(k.cpa, input.currency)}`);
  if (k.roas != null) bits.push(`ROAS ${k.roas.toFixed(2)}x`);
  lines.push(bits.join(" · "));
  if (input.spendDeltaPct != null) {
    const dir = input.spendDeltaPct >= 0 ? "+" : "";
    lines.push(`Gasto ${dir}${input.spendDeltaPct}% vs o período anterior.`);
  }
  lines.push("Os números de hoje ainda estão consolidando.");
  if (!input.updated) lines.push("(mostrando o último dado sincronizado — não consegui atualizar agora)");
  if (input.noAnalysisYet) {
    lines.push("Ainda não tenho uma análise concluída — me peça uma análise pra recomendações.");
  } else if (input.standingRecs.length > 0) {
    lines.push("");
    lines.push("Segue valendo:");
    for (const r of input.standingRecs) lines.push(`• ${r}`);
  }
  return lines.join("\n");
}
