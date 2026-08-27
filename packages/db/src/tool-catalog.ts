/**
 * Catálogo de tools de ESCRITA do agente (núcleo MVP). DADO (não lógica) — semeado em
 * `agent_tool_definitions` pelo seed. `riskLevel` aqui é o nível-tipo base; o caminho
 * de escrita refina por params (ex: cortar budget = low). Habilitação por-agente
 * (`agent_tool_bindings`) = 5c; hoje o auto-apply usa `Action.riskLevel`.
 */

/** Escopo Meta necessário p/ mutar (§9). */
const ADS_MANAGEMENT = "ads_management";

/** Política de aprovação por capacidade (S4) — espelha o pgEnum tool_approval_policy. */
export type ToolApprovalPolicy = "auto" | "approvals_table" | "chat_confirm";

export interface ToolCatalogEntry {
  readonly key: string;
  readonly description: string;
  readonly riskLevel: "low" | "medium" | "high";
  readonly isIdempotent: boolean;
  readonly requiredPermission: string;
  /** o chat pode executá-la quando pedida. */
  readonly executableInChat: boolean;
  /** a análise pode recomendá-la (semeia platform_action). */
  readonly proposable: boolean;
  readonly approvalPolicy: ToolApprovalPolicy;
}

// As 4 de otimização: executáveis no chat E propostas na análise; gate por
// autonomia/guardrail hoje (approvals_table declara o inbox site+WhatsApp).
const OPT_DEFAULTS = { isIdempotent: true, requiredPermission: ADS_MANAGEMENT, executableInChat: true, proposable: true, approvalPolicy: "approvals_table" as const };
// Criação (Fatia 7 / config por-ação): gasto NOVO, risco alto, não-idempotente. `proposable` (a
// análise propõe/auto-cria) + `executableInChat` (o dono pede no chat). Gate por binding = net-new.
const CREATE_DEFAULTS = { isIdempotent: false, requiredPermission: ADS_MANAGEMENT, executableInChat: true, proposable: true, approvalPolicy: "approvals_table" as const };
export const AGENT_TOOL_CATALOG: readonly ToolCatalogEntry[] = [
  { key: "pause_entity", description: "Pausar uma entidade (parar o gasto).", riskLevel: "low", ...OPT_DEFAULTS },
  { key: "resume_entity", description: "Retomar uma entidade pausada.", riskLevel: "medium", ...OPT_DEFAULTS },
  { key: "set_status", description: "Definir o status de uma entidade.", riskLevel: "medium", ...OPT_DEFAULTS },
  { key: "adjust_budget", description: "Ajustar o budget da entidade (±%).", riskLevel: "medium", ...OPT_DEFAULTS },
  { key: "create_campaign", description: "Criar uma campanha nova (gasto novo).", riskLevel: "high", ...CREATE_DEFAULTS },
  { key: "duplicate_scale", description: "Duplicar um vencedor pra escalar (gasto novo).", riskLevel: "high", ...CREATE_DEFAULTS },
];
