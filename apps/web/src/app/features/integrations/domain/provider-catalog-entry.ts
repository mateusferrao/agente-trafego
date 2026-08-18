/**
 * Entrada mínima de catálogo consumida pelo connect-dialog. Mantida enxuta de
 * propósito (o catálogo completo do Automato — categorias, logos, OAuth, deeplinks
 * — não é necessário no MVP: um provider paste-token). Cresce quando WhatsApp (5b/6b)
 * e outros providers entrarem.
 */
export interface ProviderCatalogEntry {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  /** Chave que resolve o connector no registry. */
  readonly connectorKey: string;
  /** Link opcional p/ a documentação oficial (passo-a-passo do token). */
  readonly docsUrl?: string;
}
