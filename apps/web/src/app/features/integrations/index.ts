// Superfície pública da feature de integrações. Outras features (ex: /accounts)
// consomem só o que está aqui — nunca os arquivos internos (connectors/catalog).
export { ConnectDialogComponent } from './components/connect-dialog';
export type { ConnectDialogDoneEvent } from './components/connect-dialog';
export { META_PROVIDER_ENTRY } from './catalog/provider-catalog';
export type { ProviderCatalogEntry } from './domain/provider-catalog-entry';
export type { ConnectResult } from './domain/connect-result';
