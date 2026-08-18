# Revisar — Aderência Backend

Checklist de aderência (além do que o `/code-review` cobre). Cada item violado = candidato a **bloqueia**. Fonte: `CLAUDE.md`.

## Arquitetura (VSA + portas + core puro)

- [ ] **Core puro:** `packages/core` não importa infra (sem `fetch`/db/Redis/adapter). Decisão pura, IO fora.
- [ ] **Portas só nas bordas:** integração externa nova entra atrás de porta em `packages/shared/src/ports` + adapter; core depende da interface, não da impl.
- [ ] **Sem vazamento cross-slice:** slice não importa interno de outro slice; compartilhado sobe pra `packages` (regra 3x).
- [ ] **Erros:** exceção só na casca (mapeada no `error-handler`); core retorna `Result<T,E>` tipado — sem exceção como control-flow no core.

## Regras de negócio (CLAUDE.md → Regras de negócio)

- [ ] **Org-scoping:** toda query nova filtra por `org_id`. Procurar query sem escopo = vazamento cross-tenant (bloqueia).
- [ ] **Idempotência:** mutação Meta usa `idempotency_key`; grava `before_state` p/ rollback.
- [ ] **Eco+confirma:** todo caminho de escrita conversacional ecoa a ação concreta e espera confirmação antes de aplicar. Caminho autônomo só aplica dentro do guardrail.
- [ ] **Guardrail independente da aprovação:** aprovação humana não substitui guardrail.
- [ ] **Metering:** write novo registra `usage_events` via `MeteringPort`.

## Princípios de engenharia (CLAUDE.md → Convenções)

- [ ] **Sem string mágica/hardcoded:** URLs, números, chaves em const/env nomeados.
- [ ] **Funções enxutas:** função grande/multi-responsabilidade → sinalizar refatoração.
- [ ] **Abstração/desacoplamento + nomenclatura durável** (CLAUDE.md → *Desacoplamento* / *Nomenclatura no nível certo de abstração*): a unidade depende de interface, não de impl; e **nomes** (tabela/coluna/tipo/campo/rota/função) não vazam fase (`beta`), provider num conceito genérico, nem detalhe de impl — trocar impl/sair da fase não deve exigir renomear o conceito. Nome acoplado → sinalizar.
- [ ] **Reuso:** lógica duplicada que já existe em `packages/{shared,core,db}`/adapters → sinalizar reuso.
- [ ] **ESM:** imports relativos com `.js`; cross-package `@trafego/*`.

## Testes

- [ ] Core novo tem teste (sem mock). Adapter/service com externo mockado. Grafo com fixture (incl. `approval → resume`).
