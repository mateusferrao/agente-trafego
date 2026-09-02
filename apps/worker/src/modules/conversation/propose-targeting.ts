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

/**
 * Chama a LLM pra propor o público da oportunidade. Retorna `null` em falha (o caller degrada pro
 * comportamento default — reuse/amplo — sem quebrar o run). Metering atribui o custo à org/tipo.
 */
export async function proposeTargetingForOpportunity(llm: LLMProviderPort, input: ProposeTargetingInput): Promise<ProposedTargeting | null> {
  const aud = input.winnerAudience;
  const audienceSummary = aud
    ? `Público do vencedor: estágio ${aud.stage}; ${(aud.geo ?? []).join(", ") || "geo n/d"}; idade ${aud.ageMin ?? "?"}-${aud.ageMax ?? "?"}; ${(aud.interests ?? []).slice(0, 5).join(", ") || "sem interesses"}.`
    : "Sem vencedor com público legível.";
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

  try {
    const { output } = await llm.completeStructured<unknown>({
      model: input.model,
      messages: [
        { role: "system", content: SYSTEM },
        { role: "user", content: user },
      ],
      responseSchema: RESPONSE_SCHEMA,
      responseSchemaName: "proposed_targeting",
      temperature: 0.4,
      validate: (o) => proposedTargetingSchema.safeParse(o).success,
      meta: { orgId: input.meta.orgId, ...(input.meta.runId ? { runId: input.meta.runId } : {}), type: "propose_targeting" },
    });
    const parsed = proposedTargetingSchema.safeParse(output);
    return parsed.success ? parsed.data : null;
  } catch {
    return null; // LLM indisponível → caller cai no default (reuse/amplo)
  }
}
