// Saúde da conta Meta (S3, pivô saúde de conta): detecção de transição + mensagem
// determinística (SEM LLM — o conteúdo é fato estruturado, nada pra interpretar,
// mesmo espírito de `describePartialRun`). O gatilho de token inválido não passa por
// aqui (vem de um path totalmente diferente, `markConnectionTokenInvalid`) — só a
// composição da mensagem (`describeAccountHealthAlert`) é compartilhada.
import { formatMoney } from "@trafego/shared";
import { ACCOUNT_HEALTH_STATUS_LABELS, type AccountHealth, type MetaAccountHealthStatus } from "@trafego/shared/types";
import type { AccountHealthAlertPolicy } from "@trafego/shared/schemas";

export type AccountHealthTriggerKind = "status" | "spend_cap" | "balance" | "token_invalid";

export interface AccountHealthTriggerEvent {
  readonly kind: AccountHealthTriggerKind;
  readonly status?: Exclude<MetaAccountHealthStatus, "active">;
  readonly spendCapMajor?: number;
  readonly balanceMajor?: number;
}

/** Estado de saúde persistido no sync ANTERIOR (`null` = nunca checado antes — não é
 *  considerado transição, evita disparar no 1º sync de toda conta existente). */
export interface PreviousAccountHealthSnapshot {
  readonly status: MetaAccountHealthStatus | null;
  readonly amountSpentMajor: number | null;
  readonly balanceMajor: number | null;
}

/**
 * Detecta gatilhos de TRANSIÇÃO (nunca redispara enquanto o problema persiste sem
 * mudar). Pura — sem IO, sem chamada à Meta (o worker já buscou `current` via
 * `getAccountHealth`). Quem decide relevância de status é o dono (`statusTriggers`,
 * checklist) — esta função não julga gravidade.
 */
export function detectAccountHealthTriggers(
  previous: PreviousAccountHealthSnapshot,
  current: AccountHealth,
  policy: AccountHealthAlertPolicy,
): readonly AccountHealthTriggerEvent[] {
  if (!policy.enabled) return [];
  const events: AccountHealthTriggerEvent[] = [];

  // 1) status: só dispara se mudou de fato E o dono marcou esse status no checklist.
  if (
    current.status !== "active" &&
    current.status !== previous.status &&
    (policy.statusTriggers as readonly MetaAccountHealthStatus[]).includes(current.status)
  ) {
    events.push({ kind: "status", status: current.status as Exclude<MetaAccountHealthStatus, "active"> });
  }

  // 2) teto de gasto: Meta ou valor customizado, sempre na moeda da conta. "0" da Meta já
  // chega como spendCapMajor ausente (achado ao vivo — o adapter resolve isso).
  const capThreshold =
    policy.spendThreshold.source === "custom" ? policy.spendThreshold.customValueMajor : current.spendCapMajor;
  if (capThreshold !== undefined && current.amountSpentMajor !== undefined) {
    const wasOver = previous.amountSpentMajor !== null && previous.amountSpentMajor >= capThreshold;
    const isOver = current.amountSpentMajor >= capThreshold;
    if (isOver && !wasOver) events.push({ kind: "spend_cap", spendCapMajor: capThreshold });
  }

  // 3) saldo baixo: só quando pré-pago genuíno (fundingType stored_balance) — pra
  // cartão/fatura o dado é valor acumulado-não-cobrado, não confiável (achado ao vivo).
  const balanceThreshold = policy.balanceThreshold.customValueMajor;
  if (
    policy.balanceThreshold.enabled &&
    current.fundingType === "stored_balance" &&
    balanceThreshold !== undefined &&
    current.balanceMajor !== undefined
  ) {
    const wasUnder = previous.balanceMajor !== null && previous.balanceMajor <= balanceThreshold;
    const isUnder = current.balanceMajor <= balanceThreshold;
    if (isUnder && !wasUnder) events.push({ kind: "balance", balanceMajor: current.balanceMajor });
  }

  return events;
}

/**
 * Mensagem determinística (sem LLM) — copy validada nesta sessão, mesmo tom do resto
 * do app (direto, "você", explica impacto, sem travessão). O gatilho `token_invalid`
 * não usa `event` (a mensagem é sempre a mesma, o fato não varia).
 */
export function describeAccountHealthAlert(
  event: AccountHealthTriggerEvent,
  accountName: string,
  currency: string,
): string {
  switch (event.kind) {
    case "status": {
      const label = event.status ? ACCOUNT_HEALTH_STATUS_LABELS[event.status] : "um status não reconhecido";
      return `Sua conta Meta ${accountName} não está ativa agora. O motivo informado pela Meta foi: ${label}. Suas campanhas podem ter parado de rodar, então vale a pena checar o Gerenciador de Anúncios ou o site pra mais detalhes.`;
    }
    case "spend_cap":
      return `Sua conta Meta ${accountName} bateu o teto de gasto de ${formatMoney(event.spendCapMajor ?? 0, currency)}, então a Meta vai parar de veicular os anúncios até você aumentar esse teto.`;
    case "balance":
      return `O saldo da sua conta Meta ${accountName} está chegando perto do fim, hoje em ${formatMoney(event.balanceMajor ?? 0, currency)}. Quando acabar, os anúncios param de rodar automaticamente, então vale a pena recarregar em breve.`;
    case "token_invalid":
      return `Não estou mais conseguindo acessar sua conta Meta porque o acesso expirou. Preciso que você reconecte no site pra eu voltar a acompanhar.`;
  }
}
