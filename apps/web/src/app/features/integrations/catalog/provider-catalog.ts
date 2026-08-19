import type { ProviderCatalogEntry } from '../domain/provider-catalog-entry';

/** Chaves de connector (resolvem a estratégia no registry). */
export const CONNECTOR_KEY = {
  metaAds: 'meta-ads',
} as const;

/** Passo-a-passo oficial p/ gerar o System User token (concierge cobre o resto no beta — §9). */
const META_SYSTEM_USER_DOCS = 'https://www.facebook.com/business/help/503306463479099';

/** Provedor Meta Ads (paste-token → connect-dialog). */
export const META_PROVIDER_ENTRY: ProviderCatalogEntry = {
  id: 'meta-ads',
  name: 'Meta Ads',
  description:
    'Conecte sua conta de anúncios do Facebook e Instagram para o agente acompanhar as campanhas.',
  category: 'Mídia paga',
  icon: 'meta-ads',
  connectFlow: 'dialog',
  connectorKey: CONNECTOR_KEY.metaAds,
  docsUrl: META_SYSTEM_USER_DOCS,
};

/** Canal WhatsApp (Evolution — fluxo próprio de QR, não usa o connect-dialog). */
export const WHATSAPP_PROVIDER_ENTRY: ProviderCatalogEntry = {
  id: 'whatsapp',
  name: 'WhatsApp',
  description: 'Conecte seu número para o agente te avisar das análises por mensagem.',
  category: 'Mensageria',
  icon: 'whatsapp',
  connectFlow: 'whatsapp-qr',
};

/** Catálogo de provedores conectáveis no MVP (grid "Disponíveis"). */
export const PROVIDER_CATALOG: readonly ProviderCatalogEntry[] = [
  META_PROVIDER_ENTRY,
  WHATSAPP_PROVIDER_ENTRY,
];
