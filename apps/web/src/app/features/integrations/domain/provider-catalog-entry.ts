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
  /** Categoria exibida no card do grid (ex: "Mídia paga", "Mensageria"). */
  readonly category: string;
  /** Logo do provedor: basename do SVG em `/integrations/<icon>.svg`. */
  readonly icon: string;
  /**
   * Como este provedor conecta: `dialog` = connect-dialog genérico (credencial →
   * escolher alvo, ex: Meta); `whatsapp-qr` = fluxo próprio de QR (Evolution).
   */
  readonly connectFlow: 'dialog' | 'whatsapp-qr';
  /** Chave que resolve o connector no registry (só p/ `connectFlow: 'dialog'`). */
  readonly connectorKey?: string;
  /** Link opcional p/ a documentação oficial (passo-a-passo do token). */
  readonly docsUrl?: string;
}
