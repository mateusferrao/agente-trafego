import type { ProviderCatalogEntry } from '../domain/provider-catalog-entry';

/** Chaves de connector (resolvem a estratégia no registry). */
export const CONNECTOR_KEY = {
  metaAds: 'meta-ads',
} as const;

/** Passo-a-passo oficial p/ gerar o System User token (concierge cobre o resto no beta — §9). */
const META_SYSTEM_USER_DOCS = 'https://www.facebook.com/business/help/503306463479099';

/** Provedor Meta Ads (paste-token). Único provider do MVP; WhatsApp entra em 5b/6b. */
export const META_PROVIDER_ENTRY: ProviderCatalogEntry = {
  id: 'meta-ads',
  name: 'Meta Ads',
  description:
    'Conecte sua conta de anúncios do Facebook e Instagram para o agente acompanhar as campanhas.',
  connectorKey: CONNECTOR_KEY.metaAds,
  docsUrl: META_SYSTEM_USER_DOCS,
};
