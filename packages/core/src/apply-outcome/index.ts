// Copy ÚNICA do desfecho de uma AÇÃO aplicada (Fatia "depois", diz×faz). Reusada pelo push do
// WhatsApp (apps/worker/approval-apply) E pelo card do site (via API) — mesma voz do Roy nos dois
// canais, num só lugar (§13 reuso-primeiro). PURA (sem IO).

import { MODERNIZATION_CODES, minorToMajor, type Action, type CampaignDraftSpec, type DraftKind, type ModernizationNote } from "@trafego/shared";
import { goalNounPt } from "../conversion/index.js";

const MODERNIZATION_CODE_SET: ReadonlySet<string> = new Set(MODERNIZATION_CODES);

/** Detalhe do desfecho — o que o apply-service classificou (com o motivo/mensagem quando há). */
export type OutcomeDetail =
  | { readonly kind: "applied" }
  | { readonly kind: "simulated" }
  | { readonly kind: "noop" }
  | { readonly kind: "blocked"; readonly reason: string }
  | { readonly kind: "failed"; readonly metaMessage?: string };

/** Resumo BREVE (1ª pessoa) do que foi aplicado — voz do Roy, por tipo de ação. */
function appliedActionLine(action: Action): string {
  const name = action.target?.name ?? "a entidade";
  switch (action.type) {
    case "pause_entity":
      return `Pausei ${name}`;
    case "resume_entity":
      return `Reativei ${name}`;
    case "set_status":
      return `Mudei o status de ${name}`;
    case "adjust_budget":
      return `Ajustei o orçamento de ${name}`;
    case "adjust_audience":
      return `Ajustei o público de ${name}`;
    default:
      return `Apliquei a ação em ${name}`;
  }
}

/** Frase de desfecho na voz do Roy (o que aconteceu + próximo passo quando cabe). PURA. */
export function describeActionOutcome(action: Action, detail: OutcomeDetail): string {
  const name = action.target?.name;
  const suffix = name ? ` (${name})` : "";
  switch (detail.kind) {
    case "applied":
      return `${appliedActionLine(action)}.`;
    case "simulated":
      return `Simulei a ação${suffix} (modo ensaio) — mostrei o que faria, sem mexer na conta.`;
    case "noop":
      return `Não precisei mexer${suffix} — já estava no estado desejado.`;
    case "blocked":
      return `Não apliquei${suffix}: ${detail.reason}.`;
    case "failed": {
      if (!detail.metaMessage) return `Não consegui aplicar agora${suffix} — a Meta não respondeu. Tenta de novo em instantes.`;
      // a mensagem da Meta pode não terminar em pontuação → normaliza p/ não emendar na próxima frase.
      const meta = detail.metaMessage.trim();
      const sep = /[.!?]$/.test(meta) ? "" : ".";
      return `${meta}${sep} Dá pra tentar de novo.`;
    }
  }
}

/** "uma campanha de vendas, R$ 50,00/dia · 2 variação(ões) de copy" ou "a duplicata do seu
 *  vencedor, R$ 80,00/dia". Sem jargão (§UX) — objetivo em PT, valor formatado. PURA. */
export function describeCreatedDraft(kind: DraftKind, spec: CampaignDraftSpec): string {
  const money = new Intl.NumberFormat("pt-BR", { style: "currency", currency: spec.currency }).format(minorToMajor(spec.dailyBudgetMinor, spec.currency));
  if (kind === "duplicate") return `a duplicata do seu vencedor, ${money}/dia`;
  const goal = spec.objective ? goalNounPt(spec.objective) : "campanha";
  const variants = spec.copyVariants?.length ?? 0;
  return `uma campanha de ${goal}, ${money}/dia${variants > 0 ? ` · ${variants} variação(ões) de copy` : ""}`;
}

/** Nota de modernização → frase PT (fonte única, por código neutro). PURA. */
function modernizationNotePt(note: ModernizationNote): string {
  switch (note.code) {
    case "attribution_window_modernized":
      return "Obs: ajustei a janela de atribuição pra 1 dia — a Meta descontinuou a janela original nesse objetivo.";
    case "budget_distributed_across_adsets":
      return "Obs: essa campanha usa orçamento por conjunto, então dividi o novo orçamento entre os conjuntos na mesma proporção — o total que você pediu foi mantido.";
  }
}

/** Lê as notas de modernização de um `created_ids` cru (defensivo — só códigos conhecidos). Fonte
 *  única p/ os dois leitores do desfecho (push do WhatsApp + card do site). PURA. */
export function readModernizations(createdIds: Record<string, unknown>): readonly ModernizationNote[] {
  const raw = createdIds["modernizations"];
  if (!Array.isArray(raw)) return [];
  return raw.filter((n): n is ModernizationNote => {
    const code = (n as { code?: unknown } | null)?.code;
    return typeof code === "string" && MODERNIZATION_CODE_SET.has(code);
  });
}

/** Desfecho de um RASCUNHO/criação (voz do Roy) — fonte única (WhatsApp + site). PURA.
 *  `partialCampaign` (G3): a saga do-zero criou a campanha mas parou no meio (a criação NÃO é
 *  atômica, ao contrário da duplicação) → a campanha ficou pausada e vazia na conta. Nunca fica
 *  silenciosa (§7 "nenhum lixo silencioso"): o desfecho nomeia e diz o próximo passo. */
export type DraftOutcomeDetail =
  | { readonly kind: "created"; readonly dryRun: boolean; readonly summary: string; readonly activated?: boolean; readonly targetingFallback?: boolean; readonly modernizations?: readonly ModernizationNote[] }
  | { readonly kind: "blocked"; readonly reason: string; readonly partialCampaign?: string }
  | { readonly kind: "failed"; readonly metaMessage?: string; readonly partialCampaign?: string };

/** Nota honesta do parcial órfão. `resumable` (falha transiente) → retomo ao reaprovar; senão
 *  (recusa determinística) → ajuste no site / recriar. Rótulo entre `*…*` quando há nome. */
function partialCampaignNote(label: string | undefined, resumable: boolean): string {
  const name = label ? `*${label}*` : "a campanha";
  const tail = resumable
    ? "quando você reaprovar, eu retomo de onde parei"
    : "ajuste ou remova ela no site, ou me peça pra recriar";
  return `Antes de parar eu já tinha criado ${name} (pausada e vazia) — ${tail}.`;
}

export function describeDraftOutcome(detail: DraftOutcomeDetail): string {
  switch (detail.kind) {
    case "created": {
      if (detail.dryRun) return `Simulei a criação de ${detail.summary} (modo ensaio) — não criei de verdade.`;
      const base = detail.activated
        ? `Criei ${detail.summary} e já ATIVEI — está no ar (a Meta ainda revisa o criativo). Se precisar, dá pra pausar na plataforma.`
        : `Criei ${detail.summary} — nasceu pausada. Revise e ative na plataforma quando quiser.`;
      const withFallback = detail.targetingFallback
        ? `${base} Obs: não consegui herdar o público que prometi (a fonte sumiu) — usei um público amplo. Revise antes de ativar.`
        : base;
      const mods = (detail.modernizations ?? []).map(modernizationNotePt);
      return mods.length ? `${withFallback} ${mods.join(" ")}` : withFallback;
    }
    case "blocked": {
      const base = `Não criei: ${detail.reason}.`;
      return detail.partialCampaign ? `${base} ${partialCampaignNote(detail.partialCampaign, false)}` : base;
    }
    case "failed": {
      const base = detail.metaMessage ? `${detail.metaMessage} Dá pra tentar de novo.` : "Não consegui criar agora — a Meta não respondeu. Tenta de novo em instantes.";
      return detail.partialCampaign ? `${base} ${partialCampaignNote(detail.partialCampaign, true)}` : base;
    }
  }
}

/** Desfecho de uma ATIVAÇÃO (2º passo HITL — ativar o que nasceu pausado). Voz do Roy. PURA.
 *  `notDelivering` (G8): ao ativar uma DUPLICATA de conjunto (que entra na campanha da fonte, não
 *  numa criada por nós), a campanha-mãe pode estar pausada — a Meta não cascateia status pra cima,
 *  então ligar só o conjunto não faz veicular. Não afirma "já está veiculando" quando não está. */
export type ActivationOutcomeDetail =
  | { readonly kind: "activated"; readonly dryRun: boolean; readonly notDelivering?: boolean }
  | { readonly kind: "blocked"; readonly reason: string }
  | { readonly kind: "failed"; readonly metaMessage?: string };

export function describeActivationOutcome(detail: ActivationOutcomeDetail): string {
  switch (detail.kind) {
    case "activated":
      if (detail.dryRun) return "Simulei a ativação (modo ensaio) — não ativei de verdade.";
      return detail.notDelivering
        ? "Liguei o conjunto, mas ele ainda não está veiculando — a campanha em que ele está deve estar pausada. Ligue a campanha na plataforma pra ele rodar."
        : "Ativei sua campanha — já está veiculando.";
    case "blocked":
      return `Não ativei: ${detail.reason}.`;
    case "failed":
      return detail.metaMessage ? `${detail.metaMessage} Dá pra tentar de novo.` : "Não consegui ativar agora — a Meta não respondeu. Tenta de novo em instantes.";
  }
}
