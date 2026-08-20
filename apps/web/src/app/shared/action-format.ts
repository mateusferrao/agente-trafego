/**
 * Rótulos e formatos de ação/entidade compartilhados entre a mini-surface (detalhe da
 * conta) e a caixa de entrada de aprovações. Fonte única (§13 reuso-primeiro).
 */
export const ACTION_TYPE_LABEL: Record<string, string> = {
  pause_entity: 'Pausar',
  resume_entity: 'Retomar',
  adjust_budget: 'Ajustar orçamento',
  set_status: 'Mudar status',
};
export const ENTITY_LEVEL_LABEL: Record<string, string> = {
  campaign: 'campanha',
  adset: 'conjunto',
  ad: 'anúncio',
};

/** Aviso do diálogo de confirmação de revert (mini-surface + `/approvals`). */
export const UNDO_WARNING =
  'Reverter volta a entidade ao estado de antes desta ação. Se ela mudou desde então, isso sobrescreve a mudança.';

/** Rótulo legível do tipo de ação (o toolKey vem cru do backend). */
export function actionTypeLabel(type: string): string {
  return ACTION_TYPE_LABEL[type] ?? type;
}

/** "campanha <nome>" (cai pro id cru quando não há nome). */
export function entityTargetLabel(level: string, id: string, name?: string | null): string {
  const l = ENTITY_LEVEL_LABEL[level] ?? level;
  return name ? `${l} ${name}` : `${l} ${id}`;
}

/** Prazo legível da aprovação a partir do `expiresAt` (ISO). null = sem prazo. */
export function deadlineText(iso: string | null): string | null {
  if (!iso) return null;
  const target = new Date(iso);
  const when = target.toLocaleString('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
  const ms = target.getTime() - Date.now();
  if (ms <= 0) return `expirando (até ${when})`;
  const hours = Math.round(ms / 3_600_000);
  return hours < 1 ? `expira em breve (até ${when})` : `expira em ~${hours}h (até ${when})`;
}
