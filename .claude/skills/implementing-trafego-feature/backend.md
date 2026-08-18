# Implementar — Backend (api / worker / packages)

Checklist acionável. Regras completas no `CLAUDE.md`.

## Onde vai cada coisa

| Tipo de mudança | Local | Notas |
|---|---|---|
| Regra/decisão pura | `packages/core/src/<dominio>` | Função pura, sem IO. Teste primeiro (RED). |
| Tipo/contrato compartilhado | `packages/shared/src/{types,schemas,ports}` | Zod é a fonte do contrato. |
| Nova integração externa | porta em `packages/shared/src/ports` + adapter em `packages/<adapter>` | Core nunca importa o adapter. |
| Caso-de-uso / endpoint | slice `apps/api/src/modules/<slice>/{routes,service,schema}.ts` | Handler fino → service → core/db. |
| Schema de dado | `packages/db/src/schema/*.ts` + `pnpm db:generate` | `org_id`-scoped. Nunca editar SQL à mão. |
| Job / grafo / análise | `apps/worker/src/{graphs,executors,schedulers,workers}` | Nós finos; regra vem do core. |

## Regras (CLAUDE.md → Backend — arquitetura / Regras de negócio)

- **Core puro:** nada de `fetch`/db/Redis em `packages/core`. IO fica na casca (adapter/service/nó do grafo).
- **Portas só nas bordas:** CRUD fala Drizzle direto; só ads/canal/LLM/vault/scheduler/metering têm porta.
- **Erros:** exceções na casca (mapeadas p/ resposta HTTP no `error-handler`); no core, `Result<T,E>` tipado.
- **Idempotência:** toda mutação Meta usa `idempotency_key`; grava `before_state` p/ rollback.
- **Org-scoping:** toda query filtra por `org_id` (helper de contexto). Sem vazamento cross-tenant.
- **Eco+confirma:** fluxo de escrita conversacional ecoa a ação concreta e espera confirmação antes de aplicar.
- **Metering:** todo write registra `usage_events` via `MeteringPort` (cross-cutting na casca, não copiado por slice).
- **ESM:** imports relativos terminam em `.js`; cross-package via `@trafego/*`.

## TDD

1. Core: escreva o teste (`*.test.ts`) → falhe → implemente a função pura → passe.
2. Adapter/service: teste com o externo mockado.
3. Grafo: fixtures gravadas (insights/criativos), incluindo o caminho `approval → resume`.

## Reuso-primeiro

Antes de criar: `grep`/buscar em `packages/shared` (portas/tipos), `packages/core` (playbook/guardrails/decision/brief), `packages/db` (schema), adapters existentes.
