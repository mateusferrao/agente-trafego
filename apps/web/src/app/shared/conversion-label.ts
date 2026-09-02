/** Rótulos amigáveis PT-BR da taxonomia neutra de conversão (fonte única no frontend). */
export const CONVERSION_LABEL: Record<string, string> = {
  purchase: 'Venda',
  lead: 'Lead',
  registration: 'Cadastro',
  initiate_checkout: 'Início de checkout',
  add_to_cart: 'Adição ao carrinho',
  view_content: 'Visualização de conteúdo',
  add_payment_info: 'Adição de pagamento',
  search: 'Busca',
  contact: 'Contato',
  subscribe: 'Assinatura',
  start_trial: 'Início de teste',
  submit_application: 'Envio de inscrição',
  messaging_started: 'Conversa iniciada',
  app_install: 'Instalação de app',
  custom: 'Conversão personalizada',
};

/** Traduz um objetivo neutro p/ PT-BR; cai no valor cru quando desconhecido. */
export function conversionLabel(goal: string | null | undefined): string {
  if (!goal) return '';
  return CONVERSION_LABEL[goal] ?? goal;
}
