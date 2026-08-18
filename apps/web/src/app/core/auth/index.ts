// core/auth — sessão do lado do cliente (placeholder).
//
// Backend: sessão custom (iron-session + argon2) atrás de AuthPort (CLAUDE.md §4/§12).
// No front, este módulo vai concentrar:
//  - um `authGuard` (CanActivateFn) que protege as rotas do app shell,
//  - um `SessionStore` (signals) com o usuário/org atuais,
//  - o gate de acesso beta (allowlist manual — CLAUDE.md §2).
//
// Cookie de sessão é HttpOnly/SameSite — o front nunca lê o token direto, só chama
// endpoints autenticados via `@core/api`. Placeholder até a feature de auth entrar.
export {};
