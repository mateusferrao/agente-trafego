---
name: reviewing-trafego-changes
description: >-
  Use when reviewing a diff, branch, or pull request in the CaquiAI
  monorepo before merging — triggers on "revisar", "revisar mudança", "revisar
  PR", "code review", "antes de mergear", "review this diff", "review before
  merge". Not for planning (use planning-trafego-feature) or writing code (use
  implementing-trafego-feature).
---

# Revisar mudanças — CaquiAI

Revisa um diff antes do merge combinando qualidade geral **+** aderência aos princípios do projeto, e emite veredito.

## Fluxo

1. **Base — reusa o existente:** rode o `/code-review` (bugs, segurança, eficiência, simplificação). Não reimplemente o que ele já cobre.
2. **Dimensão extra — aderência aos princípios deste projeto** (o net-new): cheque os itens abaixo por stack.
3. **Agregue** os achados do /code-review + aderência num relatório único com veredito.

## Execução (escala ao tamanho do diff — fan-out enxuto e temático)

- **Diff pequeno** (1-2 arquivos, 1 stack): revise **inline**, sem subagentes.
- **Diff médio/grande:** subagentes paralelos, **no máximo 4**:
  - **Fixo — 1 subagente por stack tocado:** **1 backend** e/ou **1 frontend**. Cada um cobre correção + aderência + segurança do seu stack (carrega `backend.md`/`frontend.md`). Diff só-backend = só o back; só-frontend = só o front.
  - **Adicionais — no máx 2 subagentes temáticos**, **derivados do risco do próprio diff** (não uma lista fixa). Escolha os temas pelo que a mudança realmente expõe. Exemplos: auth/tenancy → isolamento de tenant, sessão (revogação/expiry), hash de senha, cookies; escrita Meta → idempotência, guardrail, eco+confirma; adapter externo → contrato, rate-limit, mapeamento de erro; credencial → nunca logar/expor token.
  - **Total ≤ 4.** Sem tema relevante além do stack → só os fixos. Não inflar o fan-out.
- Cada subagente lê o código real e devolve findings estruturados; verifique (adversarial) achados de alto risco antes de reportar.

## Aderência — por stack

Carregue só o relevante ao diff:
- Backend tocado → [backend.md](backend.md)
- Frontend tocado → [frontend.md](frontend.md)

Fonte da verdade dos princípios = `CLAUDE.md` → *Convenções › Princípios de engenharia* e *Regras de negócio* (referencie por nome de seção).

## Saída

Findings estruturados, mais severo primeiro:
- **severidade** (bloqueia / atenção / nit) · **arquivo:linha** · **dimensão** · problema → correção.

**Veredito:** `BLOQUEIA` se houver ≥1 achado bloqueante; senão `PASSA`. Bloqueia sempre que: quebra invariante do CLAUDE.md (core impuro, porta ausente, vazamento cross-tenant, escrita sem eco+confirma, string mágica/cor hardcoded), bug de correção, ou risco de segurança.
