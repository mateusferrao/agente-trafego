// Eco determinístico de confirmação de escrita (chat, 5c). PURO: monta a frase concreta
// da(s) ação(ões) a partir da Action + before/after do dry-run — a "verdade fixa" que o
// LLM só embrulha em voz leve, sem poder alterar os números (CLAUDE §8). Reusa a taxonomia
// neutra (nada específico de Meta aqui).

import type { Action, EntityLevel } from "@trafego/shared";
import { ACTION_PARAM_STATUS, formatMoneyMinor } from "@trafego/shared";

/** Uma ação a ecoar + o estado projetado pelo dry-run + rótulos resolvidos. */
export interface EchoItem {
  readonly action: Action;
  readonly before: Record<string, unknown>;
  readonly after: Record<string, unknown>;
  /** nome legível da entidade (resolvido no nosso DB; fallback = id). */
  readonly entityName: string;
  /** nome da conta — só em org multi-conta (vira "(conta)" no eco). */
  readonly accountName?: string;
  /** moeda da conta (ISO) — formata o budget na moeda certa no eco de escrita. */
  readonly currency: string;
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

/** unidade menor → moeda da conta, ex "R$ 1234,56" / "$ 1234,56" (JPY sem casas). */
function budgetMoney(minor: unknown, currency: string): string {
  return formatMoneyMinor(Number(minor), currency);
}

/** Campo de budget presente no estado (daily preferido) + rótulo de período. */
function budgetField(state: Record<string, unknown>): { field: string; period: string } | null {
  if (state["daily_budget"] != null) return { field: "daily_budget", period: "/dia" };
  if (state["lifetime_budget"] != null) return { field: "lifetime_budget", period: " (total)" };
  return null;
}

/** Cláusula concreta de UMA ação (sem "Vou " e sem ponto final). */
function clauseOf(item: EchoItem): string {
  const { action, before, after, entityName, accountName, currency } = item;
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
      const afterR = fld ? budgetMoney(after[fld.field], currency) : "";
      const period = fld?.period ?? "";
      const clampedFrom = action.params["clampedFrom"];
      if (typeof clampedFrom === "number") {
        return `ajustar o budget ${de} ${word} ${name} pra ${afterR}${period} (você pediu ${budgetMoney(clampedFrom, currency)}, mas passa do seu limite)`;
      }
      const beforeR = fld ? budgetMoney(before[fld.field], currency) : "";
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

/** Uma reversão a ecoar: rótulo da entidade + tipo da ação original. `mode` só afeta CRIAÇÕES
 *  (create_campaign/duplicate_scale): pausar (padrão) × arquivar. */
export interface RevertEchoItem {
  readonly label: string;
  readonly actionType: string;
  readonly mode?: "pause" | "archive";
}

const CREATION_UNDO_KEYS: ReadonlySet<string> = new Set(["create_campaign", "duplicate_scale"]);

/** Cláusula por item: criação reverte pausando/arquivando a campanha criada; ação normal desfaz. */
function revertClause(it: RevertEchoItem): string {
  if (CREATION_UNDO_KEYS.has(it.actionType)) {
    return it.mode === "archive"
      ? `arquivar a campanha criada *${it.label}*`
      : `pausar a campanha criada *${it.label}*`;
  }
  return `desfazer ${UNDO_WHAT[it.actionType] ?? "a última ação"} de *${it.label}*`;
}

/** Linha de consequência p/ criações — igual ao site (pausar mantém na conta; arquivar tira da lista ativa). */
function creationConsequence(items: readonly RevertEchoItem[]): string {
  const anyArchive = items.some((it) => CREATION_UNDO_KEYS.has(it.actionType) && it.mode === "archive");
  const anyPause = items.some((it) => CREATION_UNDO_KEYS.has(it.actionType) && it.mode !== "archive");
  const parts: string[] = [];
  if (anyPause) parts.push("Pausar mantém a campanha na conta (não gasta, dá pra reativar).");
  if (anyArchive) parts.push("Arquivar tira da lista ativa na Meta (não apaga, dá pra recuperar).");
  return parts.length > 0 ? `\n${parts.join(" ")}` : "";
}

/** Eco de confirmação de reversão (chat, 5c-4). Volta a entidade ao estado anterior; criações
 *  pausam ou arquivam a campanha criada (paridade com o site) + linha de consequência. */
export function buildRevertEcho(items: readonly RevertEchoItem[]): string {
  if (items.length === 0) return "";
  const consequence = creationConsequence(items);
  if (items.length === 1) return `Vou ${revertClause(items[0]!)}.${consequence} Confirma?`;
  const lines = items.map((it, i) => `${i + 1}. ${revertClause(it)}`);
  return `Vou:\n${lines.join("\n")}${consequence}\n\nConfirma as ${items.length}?`;
}
