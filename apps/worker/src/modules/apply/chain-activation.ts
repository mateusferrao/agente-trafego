// Ativação em cadeia (a Meta não cascateia status): ativar uma campanha/conjunto religa os
// descendentes PAUSADOS, senão só o nó liga e a campanha não entrega. Pausar/→PAUSED NÃO expande
// (granularidade da pausa preservada). A leitura da árvore é injetada (`readTree`) → testável.

import { campaignDelivering, pausedDescendants, type NonDeliveryReason } from "@trafego/core";
import type { Action, ActivationNode, ActivationTree } from "@trafego/shared/types";
import { ACTION_PARAM_STATUS } from "@trafego/shared";

/** Status-alvo "ativo" que o `set_status` usa (comparado em UPPER, como o adapter faz). */
const ACTIVATE_STATUS = "ACTIVE";

/** A ação LIGA a entidade? `resume_entity` sempre; `set_status` só quando o alvo é ACTIVE. */
export function isActivateAction(a: Action): boolean {
  if (a.type === "resume_entity") return true;
  if (a.type === "set_status") return String(a.params[ACTION_PARAM_STATUS] ?? "").toUpperCase() === ACTIVATE_STATUS;
  return false;
}

/** `resume_entity` p/ um descendente da subárvore (id derivado do root → idempotência estável). */
function childResume(node: ActivationNode, level: "adset" | "ad", rootId: string): Action {
  return {
    id: `${rootId}:chain:${node.id}`,
    type: "resume_entity",
    target: { level, id: node.id, ...(node.name ? { name: node.name } : {}) },
    params: {},
    source: "llm",
    riskLevel: "medium",
    reason: "ativação em cadeia",
  };
}

function pluralize(n: number, singular: string): string {
  return `${n} ${singular}${n === 1 ? "" : "s"}`;
}

/** Linha do eco listando o que a ativação em cadeia liga além do nó pedido. */
export function activationListNote(rootLabel: string, nAdsets: number, nAds: number): string {
  const parts = [nAdsets > 0 ? pluralize(nAdsets, "conjunto") : "", nAds > 0 ? pluralize(nAds, "anúncio") : ""].filter(Boolean);
  return `Também vou ligar ${parts.join(" e ")} pausado(s) de *${rootLabel}* — senão ela não veicula.`;
}

const NON_DELIVERY_TEXT: Readonly<Record<NonDeliveryReason, string>> = {
  "sem anúncio": "essa campanha não tem anúncio",
  "anúncios pausados": "os anúncios estão pausados",
  "conjuntos pausados": "os conjuntos estão pausados",
};

/** ⚠️ quando ligar o nó não faz a campanha entregar (ex.: sem anúncio nenhum a religar). */
export function nonDeliveryNote(rootLabel: string, reason?: NonDeliveryReason): string {
  const why = reason ? ` (${NON_DELIVERY_TEXT[reason]})` : "";
  return `⚠️ *${rootLabel}* não vai veicular assim${why} — mesmo ligada, não roda até ter anúncio ativo.`;
}

/** Aviso de teto: a ativação em cadeia passa do cap de entidades/dia (ligamos mesmo assim, confirmado). */
export function capWarningNote(total: number, cap: number): string {
  return `São ${total} entidades no total, acima do seu teto de ${cap}/dia — como você confirma, ligo todas.`;
}

export interface ChainExpansion {
  /** ações originais + os resumes dos descendentes pausados. */
  readonly expanded: Action[];
  /** ids das ações-filho (p/ o eco não listar uma linha por filho). */
  readonly childIds: Set<string>;
  /** linhas de aviso p/ o eco (listagem do que liga / não-entrega). */
  readonly notes: string[];
  /** houve expansão de cadeia? (→ isenta o cap de entidades/dia no guardrail e no apply). */
  readonly chainActivated: boolean;
}

/**
 * Expande as ações de ATIVAÇÃO de campanha/conjunto pra incluir os descendentes pausados. `readTree`
 * lê a árvore viva (injetada; `null` = não deu pra ler → mantém só o nó, degradação graciosa). PURA
 * quanto ao IO. Pausar/→PAUSED e alvos ad-level passam intactos.
 */
export async function expandChainActivation(
  actions: readonly Action[],
  readTree: (level: "campaign" | "adset", id: string) => Promise<ActivationTree | null>,
): Promise<ChainExpansion> {
  const expanded: Action[] = [];
  const childIds = new Set<string>();
  const notes: string[] = [];
  let chainActivated = false;

  for (const a of actions) {
    expanded.push(a);
    if (!isActivateAction(a) || (a.target.level !== "campaign" && a.target.level !== "adset")) continue;
    const tree = await readTree(a.target.level, a.target.id);
    if (!tree) continue; // leitura falhou → só o nó (não trava a ação)
    const paused = pausedDescendants(tree);
    const rootLabel = a.target.name ?? a.target.id;
    if (paused.adsets.length + paused.ads.length > 0) {
      for (const s of paused.adsets) {
        const c = childResume(s, "adset", a.id);
        expanded.push(c);
        childIds.add(c.id);
      }
      for (const ad of paused.ads) {
        const c = childResume(ad, "ad", a.id);
        expanded.push(c);
        childIds.add(c.id);
      }
      chainActivated = true;
      notes.push(activationListNote(rootLabel, paused.adsets.length, paused.ads.length));
    } else {
      const d = campaignDelivering(tree);
      if (!d.delivering) notes.push(nonDeliveryNote(rootLabel, d.reason));
    }
  }
  return { expanded, childIds, notes, chainActivated };
}
