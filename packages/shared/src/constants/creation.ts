/** Constantes de criação de campanha (Fatia 7) — fonte única compartilhada por API e worker. */

/** Nº padrão de anúncios num rascunho novo (variações de copy sobre o criativo padrão). */
export const DEFAULT_VARIANTS = 2;

/** Teto de anúncios por rascunho (add/remove por anúncio) — rede contra explosão de custo/UI.
 *  A Meta permite muitos; poucos e bons batem com o ICP não-técnico. */
export const MAX_ADS_PER_DRAFT = 10;
