// Proposta de PÚBLICO por LLM para uma recomendação PROATIVA de criação/cópia (Fatia 8). A detecção
// da oportunidade é determinística (o QUÊ); AQUI a LLM decide o COMO (o público), por NOME/intenção —
// nunca ids (a resolução nome→id é determinística e autônomo-safe na casca, descarta o inexistente).
// Honestidade: propõe só o que os sinais do brief sustentam; nada de inventar métrica/negócio.
import { z } from "zod";
import type { AudienceProfile, ConversionGoal, CreationOpportunityKind } from "@trafego/shared";
import type { LLMProviderPort } from "@trafego/shared/ports";

/** Público proposto pela LLM — tudo por NOME/termo; a casca resolve→id (descarta o não-resolvido). */
export const proposedTargetingSchema = z.object({
  /** criar do zero OU copiar a estrutura de um vencedor (então `sourceCampaignId` obrigatório). */
  mode: z.enum(["create", "copy"]),
  sourceCampaignId: z.string().nullable().optional(),
  geoNames: z.array(z.string()).default([]),
  radiusKm: z.number().positive().nullable().optional(),
  ageMin: z.number().int().min(13).max(65).nullable().optional(),
  ageMax: z.number().int().min(13).max(65).nullable().optional(),
  gender: z.enum(["all", "men", "women"]).nullable().optional(),
  interestNames: z.array(z.string()).default([]),
  behaviorNames: z.array(z.string()).default([]),
  includeAudienceNames: z.array(z.string()).default([]),
  excludeAudienceNames: z.array(z.string()).default([]),
  /** por que esse público faz sentido (1 frase, PT, sem jargão) — entra no rationale da recomendação. */
  rationale: z.string(),
});
export type ProposedTargeting = z.infer<typeof proposedTargetingSchema>;

/** Público proposto pela LLM (por NOME) → args de targeting (geo/idade/gênero/interesses/públicos),
 *  resolvidos determinístico depois (autônomo-safe). Só inclui o que a LLM propôs (vazios ficam de
 *  fora). Reusado pela criação (create/copy) E pela edição de público (adjust_audience). */
export function proposedTargetingToArgs(p: ProposedTargeting): {
  geo?: readonly string[];
  radiusKm?: number;
  ageMin?: number;
  ageMax?: number;
  gender?: "all" | "men" | "women";
  interests?: readonly string[];
  behaviors?: readonly string[];
  includeAudiences?: readonly string[];
  excludeAudiences?: readonly string[];
} {
  return {
    ...(p.geoNames.length > 0 ? { geo: p.geoNames } : {}),
    ...(p.radiusKm != null ? { radiusKm: p.radiusKm } : {}),
    ...(p.ageMin != null ? { ageMin: p.ageMin } : {}),
    ...(p.ageMax != null ? { ageMax: p.ageMax } : {}),
    ...(p.gender ? { gender: p.gender } : {}),
    ...(p.interestNames.length > 0 ? { interests: p.interestNames } : {}),
    ...(p.behaviorNames.length > 0 ? { behaviors: p.behaviorNames } : {}),
    ...(p.includeAudienceNames.length > 0 ? { includeAudiences: p.includeAudienceNames } : {}),
    ...(p.excludeAudienceNames.length > 0 ? { excludeAudiences: p.excludeAudienceNames } : {}),
  };
}

/** JSON Schema do structured output (o provider valida o shape; `validate` refina com o zod). */
const RESPONSE_SCHEMA: Readonly<Record<string, unknown>> = {
  type: "object",
  additionalProperties: false,
  required: ["mode", "geoNames", "interestNames", "behaviorNames", "includeAudienceNames", "excludeAudienceNames", "rationale"],
  properties: {
    mode: { type: "string", enum: ["create", "copy"] },
    sourceCampaignId: { type: ["string", "null"] },
    geoNames: { type: "array", items: { type: "string" } },
    radiusKm: { type: ["number", "null"] },
    ageMin: { type: ["integer", "null"] },
    ageMax: { type: ["integer", "null"] },
    gender: { type: ["string", "null"], enum: ["all", "men", "women", null] },
    interestNames: { type: "array", items: { type: "string" } },
    behaviorNames: { type: "array", items: { type: "string" } },
    includeAudienceNames: { type: "array", items: { type: "string" } },
    excludeAudienceNames: { type: "array", items: { type: "string" } },
    rationale: { type: "string" },
  },
};

export interface ProposeTargetingInput {
  readonly kind: CreationOpportunityKind;
  readonly rationale: string;
  readonly model: string;
  /** público do vencedor (quando há) — base pra copiar/replicar/expandir. */
  readonly winnerAudience?: AudienceProfile | undefined;
  /** id da campanha vencedora (p/ mode:"copy"). */
  readonly winnerCampaignId?: string | undefined;
  /** nomes dos públicos salvos da conta (a LLM escolhe incluir/excluir POR NOME dessa lista). */
  readonly savedAudienceNames: readonly string[];
  readonly businessContext?: string | null;
  readonly guidance?: string | null;
  readonly conversionGoal?: ConversionGoal | undefined;
  /** metering: atribui o custo do LLM à org/run (mesmo padrão dos outros nós do grafo). */
  readonly meta: { readonly orgId: string; readonly runId?: string };
}

const SYSTEM = [
  "Você é estrategista de tráfego pago. Dada uma OPORTUNIDADE detectada na conta, proponha o PÚBLICO",
  "de uma campanha nova (ou cópia de um vencedor), escolhendo por NOME/termo — NUNCA invente ids.",
  "Regras: proponha só o que os sinais sustentam; nomes de interesse/comportamento reais e específicos",
  "(a casca resolve na Meta e descarta o que não existir); em REMARKETING, inclua públicos de engajados",
  "e exclua os de compradores/convertidos, escolhendo dos NOMES de públicos salvos fornecidos; para",
  "REPLICAR um vencedor use mode:'copy' com o sourceCampaignId; para prospecção nova use interesses/",
  "comportamentos ligados ao negócio. Não prometa o que o brief não mostra. Responda no schema.",
].join(" ");

/** Resumo compacto de um público legível (do vencedor ou do adset em edição) p/ o prompt. */
function describeAudienceForPrompt(aud: AudienceProfile | undefined, empty: string): string {
  return aud
    ? `Público atual: estágio ${aud.stage}; ${(aud.geo ?? []).join(", ") || "geo n/d"}; idade ${aud.ageMin ?? "?"}-${aud.ageMax ?? "?"}; ${(aud.interests ?? []).slice(0, 5).join(", ") || "sem interesses"}.`
    : empty;
}

/** Chamada LLM comum das propostas de público (structured output, mesmo schema by-names). `null` em
 *  falha/inválido → o caller degrada sem quebrar o run. Metering atribui o custo à org/tipo. */
async function runProposal(
  llm: LLMProviderPort,
  system: string,
  user: string,
  meta: { readonly orgId: string; readonly model: string; readonly runId?: string },
): Promise<ProposedTargeting | null> {
  try {
    const { output } = await llm.completeStructured<unknown>({
      model: meta.model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      responseSchema: RESPONSE_SCHEMA,
      responseSchemaName: "proposed_targeting",
      temperature: 0.4,
      validate: (o) => proposedTargetingSchema.safeParse(o).success,
      meta: { orgId: meta.orgId, ...(meta.runId ? { runId: meta.runId } : {}), type: "propose_targeting" },
    });
    const parsed = proposedTargetingSchema.safeParse(output);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * Chama a LLM pra propor o público da oportunidade. Retorna `null` em falha (o caller degrada pro
 * comportamento default — reuse/amplo — sem quebrar o run). Metering atribui o custo à org/tipo.
 */
export async function proposeTargetingForOpportunity(llm: LLMProviderPort, input: ProposeTargetingInput): Promise<ProposedTargeting | null> {
  const audienceSummary = describeAudienceForPrompt(input.winnerAudience, "Sem vencedor com público legível.");
  const user = [
    `Oportunidade: ${input.kind}. Motivo: ${input.rationale}`,
    input.businessContext ? `Negócio: ${input.businessContext}` : "",
    input.guidance ? `Orientações do dono: ${input.guidance}` : "",
    input.conversionGoal ? `Conversão de negócio: ${input.conversionGoal}` : "",
    audienceSummary,
    input.winnerCampaignId ? `Campanha vencedora (p/ copiar): ${input.winnerCampaignId}` : "",
    `Públicos salvos disponíveis (escolha por NOME p/ incluir/excluir): ${input.savedAudienceNames.length > 0 ? input.savedAudienceNames.join(" | ") : "nenhum"}`,
    "Proponha o público mais alinhado à oportunidade e ao negócio.",
  ]
    .filter(Boolean)
    .join("\n");
  return runProposal(llm, SYSTEM, user, { orgId: input.meta.orgId, model: input.model, ...(input.meta.runId ? { runId: input.meta.runId } : {}) });
}

const EDIT_SYSTEM = [
  "Você é estrategista de tráfego pago. Um CONJUNTO existente está com desempenho fraco e o analista",
  "sugeriu revisar o PÚBLICO. Proponha um público REFINADO (mais alinhado ao negócio) por NOME/termo —",
  "NUNCA invente ids. Ajuste sobre o público ATUAL: restrinja/troque interesses e comportamentos frouxos,",
  "corrija geo/idade/gênero desalinhados, e use públicos salvos (incluir engajados, excluir compradores)",
  "quando fizerem sentido. Só proponha o que o motivo do analista e o negócio sustentam — se não houver",
  "um refinamento CLARO, devolva os campos vazios (não invente público). mode é irrelevante (é edição).",
  "Nomes reais e específicos (a casca resolve na Meta e descarta o que não existir). Responda no schema.",
].join(" ");

export interface ProposeAudienceEditInput {
  /** motivo do analista (por que o público está errado) — âncora da proposta. */
  readonly rationale: string;
  readonly model: string;
  /** público ATUAL do adset (base do refinamento). */
  readonly currentAudience?: AudienceProfile | undefined;
  readonly savedAudienceNames: readonly string[];
  readonly businessContext?: string | null;
  readonly guidance?: string | null;
  readonly conversionGoal?: ConversionGoal | undefined;
  readonly meta: { readonly orgId: string; readonly runId?: string };
}

/**
 * Propõe um público REFINADO pra um adset em `review_audience` (Fatia C). Reusa o MESMO schema
 * by-names + a mesma chamada; só o SYSTEM difere (edição vs criação). `null` → o caller mantém a
 * recomendação consultiva (human_direction), sem inventar edição de público.
 */
export async function proposeAudienceEdit(llm: LLMProviderPort, input: ProposeAudienceEditInput): Promise<ProposedTargeting | null> {
  const user = [
    `Motivo do analista: ${input.rationale}`,
    input.businessContext ? `Negócio: ${input.businessContext}` : "",
    input.guidance ? `Orientações do dono: ${input.guidance}` : "",
    input.conversionGoal ? `Conversão de negócio: ${input.conversionGoal}` : "",
    describeAudienceForPrompt(input.currentAudience, "Público atual não legível."),
    `Públicos salvos disponíveis (escolha por NOME p/ incluir/excluir): ${input.savedAudienceNames.length > 0 ? input.savedAudienceNames.join(" | ") : "nenhum"}`,
    "Proponha o público refinado; se não houver refinamento claro, devolva vazio.",
  ]
    .filter(Boolean)
    .join("\n");
  return runProposal(llm, EDIT_SYSTEM, user, { orgId: input.meta.orgId, model: input.model, ...(input.meta.runId ? { runId: input.meta.runId } : {}) });
}
