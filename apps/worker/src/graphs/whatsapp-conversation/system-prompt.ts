// System prompt do chat do WhatsApp (Grafo B). Voz = identidade do AGENTE em
// contexto (reusa persona/tom/system_prompt + contexto/orientações, via composeAgentPrompt
// — a MESMA base do redator do cron). Sobre a voz, uma camada FIXA de formato/conduta.
// Sem agente em contexto (org multi-conta) → voz neutra de concierge.

import { archetypeDefaults, composeAgentPrompt, composeMethodologyPrompt } from "@trafego/core";
import type { Database } from "@trafego/db/client";
import { createAnalysisRepo } from "../../modules/analysis/repo.js";

/** Camada fixa (não é config do usuário): como se fala/conduz no WhatsApp. */
const CHAT_RULES = `
Você conversa pelo WhatsApp. Regras de formato e conduta (SEMPRE):
- Curto e direto, uma ideia por bloco (separe blocos por UMA linha em branco). Nunca parede de texto.
- Formatação do WhatsApp: *negrito* com um asterisco (nunca **), _itálico_ com underline. Sem tabelas ou títulos markdown. Emojis com parcimônia.
- Liste pendências e recomendações de forma numerada.
- sentence case; português do Brasil; traduza jargão (CPA, adset, ROAS) quando usar.
- NUNCA afirme um número ou dado que não veio de uma tool. Quando uma tool trouxer métrica, cite o frescor ("dados até ...").
- Se não tiver o dado, ou não puder fazer algo por aqui, diga com clareza — nunca invente nem finja que fez.
- Ambiguidade → pergunte antes de agir.

O que você PODE fazer por aqui: consultar o status da conta, o gasto por período, a análise de uma campanha, as recomendações e o que está aguardando aprovação; e disparar uma análise ("analisa agora").
O que você NÃO faz por aqui (ainda): criar ou editar campanhas, mudar a configuração do agente, ou pausar/ajustar direto — isso é pelo site.
`.trim();

const CONCIERGE_PROMPT = `
Você é o assistente de anúncios no WhatsApp desta organização, que gerencia VÁRIAS contas.

${CHAT_RULES}

Como há mais de uma conta, por aqui você mostra o que está aguardando aprovação (de todas as contas). Para status, métricas ou análise de uma conta específica, oriente a usar o site por enquanto.
`.trim();

export interface ConversationConfig {
  readonly systemPrompt: string;
  /** modelo do chat: por-agente (`model_config.messageModel`) com fallback ao env. */
  readonly model: string;
}

/** Monta a voz + o modelo do turno. `agentId` null → concierge (org multi-conta). */
export async function loadConversationConfig(
  db: Database,
  orgId: string,
  agentId: string | null,
  fallbackModel: string,
): Promise<ConversationConfig> {
  if (!agentId) return { systemPrompt: CONCIERGE_PROMPT, model: fallbackModel };

  const ctx = await createAnalysisRepo(db).loadAgentContext(orgId, agentId);
  if (!ctx) return { systemPrompt: CONCIERGE_PROMPT, model: fallbackModel };

  const methodologyBase = ctx.systemPrompt ?? composeMethodologyPrompt(archetypeDefaults(ctx.archetype));
  const identity = [ctx.persona ? `Persona: ${ctx.persona}` : "", ctx.tone ? `Tom da comunicação: ${ctx.tone}` : ""]
    .filter((s) => s.length > 0)
    .join("\n");
  const base = identity ? `${methodologyBase}\n\n${identity}` : methodologyBase;
  const voice = composeAgentPrompt(base, {
    ...(ctx.businessContext ? { businessContext: ctx.businessContext } : {}),
    ...(ctx.guidance ? { guidance: ctx.guidance } : {}),
  });

  const messageModel = ctx.modelConfig?.["messageModel"];
  const model = typeof messageModel === "string" && messageModel.length > 0 ? messageModel : fallbackModel;
  return { systemPrompt: `${voice}\n\n${CHAT_RULES}`, model };
}
