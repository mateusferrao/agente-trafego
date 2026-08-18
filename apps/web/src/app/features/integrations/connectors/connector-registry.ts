import { InjectionToken, inject } from '@angular/core';
import { MetaAdsConnector } from './meta-ads.connector';
import { CONNECTOR_KEY } from '../catalog/provider-catalog';
import type { ConnectorStrategy } from './connector-strategy';

export type ConnectorRegistry = Readonly<Record<string, ConnectorStrategy>>;

/**
 * Registry de connectors (por chave). MVP: só Meta Ads; novos providers (WhatsApp
 * QR em 5b/6b) entram como novas entradas, sem tocar no connect-dialog.
 */
export const CONNECTOR_REGISTRY = new InjectionToken<ConnectorRegistry>(
  'integrations.connector-registry',
  {
    providedIn: 'root',
    factory: () => ({ [CONNECTOR_KEY.metaAds]: inject(MetaAdsConnector) }),
  },
);

export function resolveConnector(
  registry: ConnectorRegistry,
  key: string | undefined,
): ConnectorStrategy | null {
  if (!key) return null;
  return registry[key] ?? null;
}
