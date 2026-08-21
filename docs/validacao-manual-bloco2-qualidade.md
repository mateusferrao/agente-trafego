# Validação manual — Bloco 2, sub-projeto 1 (qualidade + público)

Roteiro para validar as sub-fatias S1.1–S1.8 numa conta real (ex: Steticos).
Pré-req: `.env` configurado, `pnpm db:migrate` (sem migration nova neste ciclo),
worker + api rodando, uma conta Meta conectada com histórico.

## 0. Estático
```bash
pnpm typecheck
pnpm test
pnpm api:generate   # sem diff pendente após rodar
pnpm --filter web run tokens:check
```

## 1. Público (S1.1) + frequência por estágio (S1.2)
Rode uma análise (botão "Analisar agora" na conta ou aguarde o cron).
- No `metrics_snapshot` do run (ou no log do brief), os adsets têm `audience`
  (`stage` frio/quente, `customAudienceCount`, geo, faixa etária). Adset com
  custom audience de retargeting (nome tipo "Visitantes"/"Engajou") → `remarketing`;
  só amplo/interesses/lookalike → `prospecting`.
- **Cartão de campanha** no detalhe do run mostra a **tag de estágio** (prospecção /
  remarketing / público indefinido).
- Frequência: um adset de **prospecção** com frequência ~2,6 deve acusar
  `audience_saturation`; um de **remarketing** com a mesma frequência **não**.
  (Override por-agente: "Qualidade e limiares" → frequência p/ público frio/quente.)

## 2. Tracking furado (S1.3) — caso Steticos
Conta com **meta de venda** e muito funil de conversas + poucas vendas rastreadas
(Steticos: ~2.896 conversas × 3–10 vendas).
- `metrics_snapshot.trackingHealth.suspect = true` (funnelStarted, trackedConversions, ratio).
- **Detalhe do run**: aviso amigável "A medição de vendas parece incompleta…".
- **Mensagem do WhatsApp** ressalva a medição antes de sugerir cortes por CPA de venda.
- Uma recomendação de **pausar** uma campanha **base `target`** por CPA de venda ruim
  carrega o caveat `[tracking]` no rationale; base `proxy` **não** recebe caveat.
- Meta de conversa (messaging) → **não** dispara (a conversão é on-platform).

## 3. Não-matar-em-learning (S1.4)
Entidade nova (sem baseline / editada há pouco).
- Recomendação de **pausar** por desempenho precoce vira `investigate` com nota
  "em aprendizado — dar tempo". Escalar já era freado (guard de significância).
- Uma regra de **playbook** explícita de pausa **continua** aplicando (não passa pelo guard).

## 4. Desperdício + 80/20 (S1.5) — money shot
- `metrics_snapshot.waste`: `wastedSpend` (R$ + %) = soma dos zumbis; `pareto`
  (por base de conversão) com `misallocated` (gasta muito, entrega pouco).
- **Detalhe do run**: card "Dinheiro sem retorno" (valor + zumbis + má alocação).
- Cada recomendação de **pausa** traz no rationale "pausar libera ~R$X no período".
- **Painel** (`/`): widget de desperdício cross-conta (total + contas que mais queimam).
- **Mensagem WhatsApp** abre pelo dinheiro quando material.

## 5. Visão: body + proofStrength (S1.6)
- Após o bump de `CREATIVE_VISION_ANALYZER_VERSION`→3, o 1º run **recusta** a visão
  (cache invalidado); o 2º run **não** (cache acerta).
- O `CreativeVisionResult` cacheado (`creative_vision_analyses.result`) traz `body`
  e `proofStrength` (weak/medium/strong). `proofStrength` inválido do modelo é descartado.

## 6. Config avançada (S1.8)
- "Qualidade e limiares" mostra 4 knobs novos com **placeholder = default real**
  (frequência frio/quente, conversas por venda p/ suspeitar da medição, mínimo de
  conversas). Salvar grava em `agents.model_config.quality`; o próximo run respeita.

## Observações
- Nenhuma migration neste ciclo (tudo em jsonb/transiente + bump de versão).
- Card de criativo no web e estágio na visão ao vivo = fast-follows (ver ROADMAP).
