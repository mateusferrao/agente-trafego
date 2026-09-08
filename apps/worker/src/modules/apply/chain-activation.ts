// Ativação em cadeia (a Meta não cascateia status): ativar uma campanha/conjunto religa os
// descendentes PAUSADOS, senão só o nó liga e a campanha não entrega. Pausar/→PAUSED NÃO expande
// (granularidade da pausa preservada). A leitura da árvore é injetada (`readTree`) → testável.

import { pausedDescendants } from "@trafego/core";
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

/** ⚠️ quando não há anúncio nenhum pra veicular (ligar o nó não faz a campanha rodar). */
export function noAdsNote(rootLabel: string): string {
  return `⚠️ *${rootLabel}* não tem anúncio pra veicular — mesmo ligada, não roda até criar/adicionar um anúncio.`;
}

/** Nota quando há filhos pausados mas a ação `resume_entity` está DESLIGADA (não dá pra religar). */
export function resumeDisabledNote(rootLabel: string): string {
  return `Os conjuntos/anúncios de *${rootLabel}* estão pausados, mas "retomar" está desligado pra este agente — ligue-os no site ou libere a ação em Ações permitidas.`;
}

/** Nota de truncamento: a campanha tem mais entidades do que a página trouxe (não liguei todas). */
export function truncatedNote(rootLabel: string): string {
  return `*${rootLabel}* tem muitos conjuntos/anúncios — liguei os que consegui listar; confira o resto no site.`;
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
 * Expande as ações de ATIVAÇÃO de campanha/conjunto pra incluir os descendentes pausados NO PRÓPRIO
 * nível (o efetivo rolaria a árvore inteira). `readTree` lê a árvore viva (injetada; `null` = não deu
 * pra ler → mantém só o nó, degradação graciosa). `resumeAllowed`: se `resume_entity` está desligado,
 * NÃO expande (senão o guardrail dropava os filhos e o eco prometeria o que não liga) — avisa honesto.
 * PURA quanto ao IO. Pausar/→PAUSED e alvos ad-level passam intactos.
 */
export async function expandChainActivation(
  actions: readonly Action[],
  readTree: (level: "campaign" | "adset", id: string) => Promise<ActivationTree | null>,
  opts: { readonly resumeAllowed: boolean } = { resumeAllowed: true },
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
      if (!opts.resumeAllowed) {
        notes.push(resumeDisabledNote(rootLabel)); // não expande: 'retomar' desligado
        continue;
      }
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
      if (tree.truncated) notes.push(truncatedNote(rootLabel));
    } else if (tree.ads.length === 0) {
      notes.push(noAdsNote(rootLabel)); // nada a religar E sem anúncio → não vai veicular
    }
    // else: nada pausado no próprio nível e há anúncios (ativos) → religar o nó já faz entregar; sem nota.
  }
  return { expanded, childIds, notes, chainActivated };
}
