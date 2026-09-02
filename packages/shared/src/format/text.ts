/**
 * Helpers de texto PUROS da voz do produto (WhatsApp-first). Fonte única — evita o
 * plural robótico "sugestão(ões)" e centraliza os emojis permitidos.
 */

/**
 * Pluralização de gente: `plural(1, "sugestão", "sugestões")` → "uma sugestão";
 * `plural(4, …)` → "4 sugestões". Zero usa o plural ("0 sugestões"). O número 1 vira
 * "uma/um" só quando `one` é dado (default "uma", feminino majoritário no domínio).
 */
export function plural(n: number, singular: string, pluralForm: string, one = "uma"): string {
  if (n === 1) return `${one} ${singular}`;
  return `${n} ${pluralForm}`;
}

/**
 * Emojis permitidos nas mensagens do WhatsApp (allowlist — §Emoji do plano de voz):
 * só marcadores FUNCIONAIS. `⚠️` = alerta crítico; `💸` = âncora do money-shot
 * (o dono quer ver o dinheiro). Todo o resto (📊🚀🙂🤖🔔✅🧪…) é decorativo e sai.
 */
export const WHATSAPP_ALLOWED_EMOJI = ["⚠️", "💸"] as const;
