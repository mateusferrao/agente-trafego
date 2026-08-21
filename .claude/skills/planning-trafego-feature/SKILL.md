---
name: planning-trafego-feature
description: >-
  Use when planning a new feature, slice, screen, endpoint, entity, or port in
  the AutoTraffic monorepo BEFORE writing any code — triggers on "planejar
  feature", "planejar antes de codar", "nova tela", "novo endpoint", "novo
  slice", "novo agente", "plan a feature", "design before implementing". Not for
  writing code (use implementing-trafego-feature) or reviewing a diff (use
  reviewing-trafego-changes).
---

# Planejar feature — AutoTraffic

Planeja uma mudança **antes de codar**, raciocinando **cross-stack** (backend Node/VSA + frontend Angular juntos), ancorado nas decisões do `CLAUDE.md`. Não escreve código.

## Fluxo

**Compõe superpowers — siga na ordem:**
1. `superpowers:brainstorming` — entender intenção, requisitos e design por perguntas críticas, **uma de cada vez, sem assumir nada**. Não pule pro plano antes do design aprovado (HARD-GATE do brainstorming).
2. `superpowers:writing-plans` — transformar o design aprovado em plano de implementação fatiado e testável.

## Gates deste projeto (aplicar durante o brainstorming)

Fonte da verdade = `CLAUDE.md`. Referencie por **nome de seção** (não número). Antes de propor qualquer coisa nova:

- **Reuso-primeiro** (CLAUDE.md → *Convenções › Princípios de engenharia*): procurar em `packages/shared` (portas/tipos/schemas), `packages/core` (funções puras), `packages/db` (schema) e adapters existentes. Só propor novo se não existir.
- **Mapear a(s) camada(s) tocada(s)** (CLAUDE.md → *Backend — arquitetura* e *Portas & adapters*):
  - Regra de negócio/decisão pura? → `packages/core` (função pura, sem IO).
  - Nova integração externa (ads/canal/LLM/…)? → **porta na borda** + adapter, nunca no core.
  - Caso-de-uso/CRUD/endpoint? → **slice VSA** em `apps/api/src/modules/<slice>`.
  - Job/análise/grafo? → `apps/worker` (StateGraph, executores, schedulers).
  - Tela/config? → feature Angular em `apps/web/src/app/features/<feature>`.
  - Dado novo? → schema Drizzle em `packages/db` + migration.
- **Costura de extensibilidade:** a mudança mantém o core dependendo só de interface? Trocar provider depois = só novo adapter?
- **Regras de negócio impactadas** (CLAUDE.md → *Regras de negócio*): autonomia, guardrails, eco+confirma, org-scoping, idempotência, metering — o plano respeita?
- **Contrato:** endpoint novo = schema zod (fonte) → OpenAPI → kubb (client Angular). Sem tipo duplicado.

## Saída

Plano fatiado em slices testáveis (via writing-plans), nomeando arquivos/portas a reusar. Cada slice = demonstrável isolado.

## Handoff (com checkpoint)

Ao fim, **sugira** — sem auto-invocar: *"Plano pronto. Para implementar, use `implementing-trafego-feature` após sua aprovação."* Espere o usuário aprovar antes de codar.
