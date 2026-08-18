/**
 * Constantes de dados semeados. Compartilhadas entre o seed e os consumidores
 * (ex: a casca HTTP resolve a org beta por este slug) — sem string mágica.
 *
 * Fatia 0: a org beta é única e fixa. Quando houver signup/auth (1a), a resolução
 * de org deixa de depender deste slug.
 */
export const BETA_ORG_SLUG = "beta";
export const BETA_ORG_NAME = "Beta";
