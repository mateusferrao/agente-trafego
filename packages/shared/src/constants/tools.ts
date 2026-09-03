// Tool-keys gateáveis do agente (fonte única — antes espalhadas no worker). O on/off por-agente
// resolve por `agent_tool_bindings` (autoritativo); o resolver puro vive em `@trafego/core`.
// As 4 de AÇÃO (mutação) têm key == ActionType (identidade); as 2 de CRIAÇÃO são tool-keys à parte
// (distintas das tools de CHAT: `scale_winner` faz raise OU duplicate → o gate é por-AÇÃO, não por
// tool de chat).

import type { ActionType } from "../types/index.js";

/** Tool-keys de escrita que são AÇÕES (mutação sobre entidade existente) — key == ActionType. */
export const WRITE_ACTION_TOOL_KEYS = ["pause_entity", "resume_entity", "set_status", "adjust_budget", "adjust_audience"] as const;
export type WriteActionToolKey = (typeof WRITE_ACTION_TOOL_KEYS)[number];

/** Tool-keys de CRIAÇÃO (gasto novo). Ungated hoje; passam ao gate por binding (net-new). */
export const CREATION_TOOL_KEYS = ["create_campaign", "duplicate_scale"] as const;
export type CreationToolKey = (typeof CREATION_TOOL_KEYS)[number];

export type GateableToolKey = WriteActionToolKey | CreationToolKey;
/** Universo das tool-keys gateáveis por binding (as 6). */
export const GATEABLE_TOOL_KEYS: readonly GateableToolKey[] = [...WRITE_ACTION_TOOL_KEYS, ...CREATION_TOOL_KEYS];

const CREATION_SET: ReadonlySet<string> = new Set(CREATION_TOOL_KEYS);
/** Guard: a tool-key é de criação (gasto novo)? */
export function isCreationToolKey(key: string): boolean {
  return CREATION_SET.has(key);
}

/** tool-key de ação ↔ `ActionType` — identidade nas 4 (o gate por allowedActions usa isto). */
export const WRITE_TOOL_TO_ACTION: ReadonlyMap<string, ActionType> = new Map(
  WRITE_ACTION_TOOL_KEYS.map((k) => [k, k as ActionType]),
);

/** Modo do binding (espelha o pgEnum `tool_binding_mode`). `shadow` conta como habilitado. */
export type ToolBindingMode = "enabled" | "disabled" | "shadow";
