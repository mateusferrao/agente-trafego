/**
 * Catálogo de tools de ESCRITA do agente (núcleo MVP). DADO (não lógica) — semeado em
 * `agent_tool_definitions` pelo seed. `riskLevel` aqui é o nível-tipo base; o caminho
 * de escrita refina por params (ex: cortar budget = low). Habilitação por-agente
 * (`agent_tool_bindings`) = 5c; hoje o auto-apply usa `Action.riskLevel`.
 */

/** Escopo Meta necessário p/ mutar (§9). */
const ADS_MANAGEMENT = "ads_management";

export interface ToolCatalogEntry {
  readonly key: string;
  readonly description: string;
  readonly riskLevel: "low" | "medium" | "high";
  readonly isIdempotent: boolean;
  readonly requiredPermission: string;
}

export const AGENT_TOOL_CATALOG: readonly ToolCatalogEntry[] = [
  { key: "pause_entity", description: "Pausar uma entidade (parar o gasto).", riskLevel: "low", isIdempotent: true, requiredPermission: ADS_MANAGEMENT },
  { key: "resume_entity", description: "Retomar uma entidade pausada.", riskLevel: "medium", isIdempotent: true, requiredPermission: ADS_MANAGEMENT },
  { key: "set_status", description: "Definir o status de uma entidade.", riskLevel: "medium", isIdempotent: true, requiredPermission: ADS_MANAGEMENT },
  { key: "adjust_budget", description: "Ajustar o budget da entidade (±%).", riskLevel: "medium", isIdempotent: true, requiredPermission: ADS_MANAGEMENT },
];
