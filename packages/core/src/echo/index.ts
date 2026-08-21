// Eco determinístico de confirmação de escrita (chat, 5c). PURO: monta a frase concreta
// da(s) ação(ões) a partir da Action + before/after do dry-run — a "verdade fixa" que o
// LLM só embrulha em voz leve, sem poder alterar os números (CLAUDE §8). Reusa a taxonomia
// neutra (nada específico de Meta aqui).

import type { Action, EntityLevel } from "@trafego/shared";
import { ACTION_PARAM_STATUS } from "@trafego/shared";

/** Uma ação a ecoar + o estado projetado pelo dry-run + rótulos resolvidos. */
export interface EchoItem {
  readonly action: Action;
  readonly before: Record<string, unknown>;
  readonly after: Record<string, unknown>;
  /** nome legível da entidade (resolvido no nosso DB; fallback = id). */
  readonly entityName: string;
  /** nome da conta — só em org multi-conta (vira "(conta)" no eco). */
  readonly accountName?: string;
}

const WORD: Record<EntityLevel, string> = {
  account: "conta",
  campaign: "campanha",
  adset: "conjunto",
  ad: "anúncio",
};
/** artigo definido do substantivo (pt-BR): campanha/conta = "a"; conjunto/anúncio = "o". */
const ARTICLE: Record<EntityLevel, "a" | "o"> = {
  account: "a",
  campaign: "a",
  adset: "o",
  ad: "o",
};

const STATUS_LABEL: Record<string, string> = {
  active: "ativo",
  paused: "pausado",
  deleted: "removido",
  archived: "arquivado",
};

/** minor units (centavos) → "R$ 1234,56". */
function brl(minor: unknown): string {
  const n = Number(minor);
  if (!Number.isFinite(n)) return "R$ 0,00";
  return `R$ ${(n / 100).toFixed(2).replace(".", ",")}`;
}

/** Campo de budget presente no estado (daily preferido) + rótulo de período. */
function budgetField(state: Record<string, unknown>): { field: string; period: string } | null {
  if (state["daily_budget"] != null) return { field: "daily_budget", period: "/dia" };
  if (state["lifetime_budget"] != null) return { field: "lifetime_budget", period: " (total)" };
  return null;
}

/** Cláusula concreta de UMA ação (sem "Vou " e sem ponto final). */
function clauseOf(item: EchoItem): string {
  const { action, before, after, entityName, accountName } = item;
  const level = action.target.level;
  const word = WORD[level];
  const article = ARTICLE[level];
  const name = `*${entityName}*${accountName ? ` (${accountName})` : ""}`;

  switch (action.type) {
    case "pause_entity":
      return `pausar ${article} ${word} ${name}`;
    case "resume_entity":
      return `reativar ${article} ${word} ${name}`;
    case "set_status": {
      const raw = String(action.params[ACTION_PARAM_STATUS] ?? "").toLowerCase();
      return `mudar ${article} ${word} ${name} para ${STATUS_LABEL[raw] ?? raw}`;
    }
    case "adjust_budget": {
      const de = article === "a" ? "da" : "do";
      const fld = budgetField(after) ?? budgetField(before);
      const afterR = fld ? brl(after[fld.field]) : "";
      const period = fld?.period ?? "";
      const clampedFrom = action.params["clampedFrom"];
      if (typeof clampedFrom === "number") {
        return `ajustar o budget ${de} ${word} ${name} pra ${afterR}${period} (você pediu ${brl(clampedFrom)}, mas passa do seu limite)`;
      }
      const beforeR = fld ? brl(before[fld.field]) : "";
      return `ajustar o budget ${de} ${word} ${name}: ${beforeR} → ${afterR}${period}`;
    }
    default:
      return `mexer ${article} ${word} ${name}`;
  }
}

/** Monta o eco de confirmação (1 ação = frase; N ações = lista numerada). */
export function buildWriteEcho(items: readonly EchoItem[]): string {
  if (items.length === 0) return "";
  if (items.length === 1) return `Vou ${clauseOf(items[0]!)}. Confirma?`;
  const lines = items.map((it, i) => `${i + 1}. ${clauseOf(it)}`);
  return `Vou fazer:\n${lines.join("\n")}\n\nConfirma as ${items.length}?`;
}

/** Rótulo do que se desfaz, por tipo de ação original. */
const UNDO_WHAT: Record<string, string> = {
  pause_entity: "a pausa",
  resume_entity: "a reativação",
  set_status: "a mudança de status",
  adjust_budget: "o ajuste de budget",
};

/** Uma reversão a ecoar: rótulo da entidade + tipo da ação original. */
export interface RevertEchoItem {
  readonly label: string;
  readonly actionType: string;
}

/** Eco de confirmação de reversão (chat, 5c-4). Volta a entidade ao estado anterior. */
export function buildRevertEcho(items: readonly RevertEchoItem[]): string {
  const clause = (it: RevertEchoItem) => `desfazer ${UNDO_WHAT[it.actionType] ?? "a última ação"} de *${it.label}*`;
  if (items.length === 0) return "";
  if (items.length === 1) return `Vou ${clause(items[0]!)} (volta ao estado anterior). Confirma?`;
  const lines = items.map((it, i) => `${i + 1}. ${clause(it)}`);
  return `Vou desfazer:\n${lines.join("\n")}\n\nConfirma as ${items.length}?`;
}
