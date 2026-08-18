---
name: implementing-trafego-feature
description: >-
  Use when writing code for a planned feature, slice, endpoint, graph node,
  adapter, or Angular component in the Agente de Tráfego monorepo — triggers on
  "implementar", "implementar feature", "codar", "codar o plano", "escrever o
  slice", "implement the plan", "build the feature". Assumes a plan/design
  already exists. Not for planning (use planning-trafego-feature) or reviewing a
  diff (use reviewing-trafego-changes).
---

# Implementar feature — Agente de Tráfego

Implementa uma mudança já planejada, seguindo TDD e os invariantes do `CLAUDE.md`. Um plano/design deve existir antes (senão, use `planning-trafego-feature`).

## Fluxo

**Compõe superpowers:**
1. `superpowers:test-driven-development` — RED → GREEN → REFACTOR em cada slice. Comece pelo **core puro** (`packages/core`): teste primeiro, sem mock.
2. `superpowers:subagent-driven-development` — quando o plano tem slices **independentes**, um subagente por slice.

## Implementação fatiada (padrão)

**Toda** implementação é fatiada — não só quando há slices independentes. Nunca big-bang.

- Antes de codar, decompor a feature nas **menores micro-slices testáveis/demonstráveis**. Se o plano já trouxe as slices (ex: S0→Sn), seguir; senão, defini-las primeiro.
- Implementar **uma slice por vez**: RED → GREEN → REFACTOR + `superpowers:verification-before-completion` **antes** de começar a próxima. Não abrir a slice seguinte com a anterior incompleta/vermelha.
- Cada slice = **demonstrável isolada** (roda ou testa sozinha) e deixa a árvore verde.
- `subagent-driven-development` = quando as slices são **independentes** (1 subagente/slice); slices **seriais** vão uma-a-uma na mesma sessão, mesmo assim.
- Rastrear o progresso das slices (todo list) e reportar o avanço slice a slice.

## Invariantes (aplicar sempre)

Fonte da verdade = `CLAUDE.md` (referencie por nome de seção):
- **Princípios de engenharia** (CLAUDE.md → *Convenções › Princípios de engenharia*): sem string mágica/hardcoded; funções enxutas; separação de interesses; desacoplamento; reuso-primeiro.
- **Arquitetura** (CLAUDE.md → *Backend — arquitetura*): VSA; **portas só nas bordas**; **core puro** (zero IO); exceções na casca / resultados tipados no core; composition root manual.
- **Regras de negócio** (CLAUDE.md → *Regras de negócio*): idempotência (`idempotency_key`), org-scoping em toda query, **eco+confirma antes de qualquer escrita**, guardrail independente da aprovação, metering nos writes.

## Detalhe por stack

Carregue só o relevante à tarefa:
- Backend (api/worker/packages) → [backend.md](backend.md)
- Frontend (Angular/web) → [frontend.md](frontend.md)

## Verificação antes de concluir

Use `superpowers:verification-before-completion`: rode os testes do(s) package(s) tocado(s); no frontend rode `tokens:check`. Evidência antes de afirmar "pronto".

## Handoff (com checkpoint)

Ao fim, **sugira** — sem auto-invocar: *"Implementado e verificado. Para revisar antes de mergear, use `reviewing-trafego-changes`."*
