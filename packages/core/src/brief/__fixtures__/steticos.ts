// Fixture-ouro (Fatia 6c) — conta real de clínica (funil por conversa no WhatsApp),
// ANONIMIZADA: rótulos identificadores trocados por genéricos; magnitudes reais
// preservadas (CTR ~2,5%, CPM ~R$27, conversa como conversão de negócio). Exercita
// a curadoria + a camada de qualidade (tiers/sinais/elegibilidade) ponta a ponta.

import type { AdEntity, InsightRow } from "@trafego/shared";

const OBJ = { goal: "messaging_started" as const };

export const STETICOS_ACCOUNT = { id: "acct-teste", name: "Clínica (conta de teste)", currency: "BRL" };

export const STETICOS_ENTITIES: readonly AdEntity[] = [
  { id: "acct-teste", level: "account", name: "Clínica (conta de teste)", status: "active" },
  { id: "C_ESCALA", level: "campaign", name: "Campanha Escala", status: "active", objective: OBJ },
  { id: "C_ZUMBI", level: "campaign", name: "Campanha Parada", status: "active", objective: OBJ },
  { id: "C_FADIGA", level: "campaign", name: "Campanha Cansada", status: "active", objective: OBJ },
  { id: "C_NOVA", level: "campaign", name: "Campanha Nova", status: "active", objective: OBJ },
];

/** Linha agregada da janela (sem data) — normalize soma; deltas vêm do baseline. */
function row(entityId: string, level: "account" | "campaign", spend: number, impressions: number, clicks: number, ctr: number, conversas: number, frequency?: number): InsightRow {
  return {
    entityId,
    level,
    metrics: {
      spend,
      impressions,
      clicks,
      ctr,
      cpc: clicks > 0 ? spend / clicks : 0,
      cpm: impressions > 0 ? (spend / impressions) * 1000 : 0,
      ...(frequency !== undefined ? { frequency } : {}),
    },
    conversions: [{ goal: "messaging_started", count: conversas }],
  };
}

// Janela atual (7d)
export const STETICOS_ROWS: readonly InsightRow[] = [
  row("acct-teste", "account", 18800, 684000, 17300, 2.53, 2896, 2.54),
  row("C_ESCALA", "campaign", 6000, 240000, 6800, 2.83, 1200, 2.2), // winner: cpa 5
  row("C_ZUMBI", "campaign", 300, 9000, 40, 0.44, 0), // zombie: gastou, 0 conversa
  row("C_FADIGA", "campaign", 4000, 150000, 3000, 2.0, 500, 3.4), // fadiga + underperformer: cpa 8
  row("C_NOVA", "campaign", 500, 20000, 400, 2.0, 30), // nova: sem baseline → learning/low_volume
];

// Janela anterior (baseline 7d) — SEM C_NOVA (ela é nova).
export const STETICOS_BASELINE: readonly InsightRow[] = [
  row("acct-teste", "account", 17000, 650000, 16000, 2.46, 2600, 2.4),
  row("C_ESCALA", "campaign", 5500, 210000, 6000, 2.86, 1050, 2.1), // cpa ~5.24
  row("C_ZUMBI", "campaign", 250, 8000, 60, 0.75, 0),
  row("C_FADIGA", "campaign", 3000, 100000, 3000, 3.0, 500, 2.6), // cpa 6 → sobe p/ 8 (+33%), ctr 3→2 (-33%)
];
