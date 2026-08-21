# Validação manual — Bloco 2, sub-projeto 2 (auto-config por chat)

Roteiro para validar as sub-fatias S2.1–S2.7. Pré-req: worker + api rodando,
Evolution conectado (1 número), **contato verificado** da org, um agente ativo
numa conta. Sem migration neste ciclo.

## 0. Estático
```bash
pnpm typecheck
pnpm test
```

## 1. Camada compartilhada (S2.1/S2.2) — paridade
- A config pelo **site** (`PUT /accounts/:id/agent/config`) segue funcionando
  idêntica (testes de agents verdes). A escrita agora passa por
  `@trafego/agent-config.applyAgentConfigChange` (fonte única com o chat).

## 2. Auto-config por chat (S2.3–S2.6)
Mande mensagens do contato verificado (ou simule o inbound com um POST no webhook
Evolution — ver `docs/validacao-manual-5b.md` para o formato do payload + o secret
por-instância). O agente em contexto = a única conta ativa OU a conta focada.

- **"muda a meta pra custo por venda de R$120"** → o agente ECOA "meta de custo
  por venda: R$X → R$120" e espera confirmação. Responda **"sim"** → aplica; o
  site reflete a nova meta; grava 1 linha em `audit_log` (actor `contact:...`).
  Como a meta é relevante à análise, ele **oferece** rodar a análise agora (não
  dispara sozinho).
- **"afrouxa o limite de mudança de budget pra 30%"** → o eco vem com **aviso de
  afrouxamento** ("⚠️ Isso afrouxa sua segurança: limite de budget 20% → 30%").
  Confirma → aplica.
- **Lote**: "muda a meta pra R$120 e passa a cadência pra 2×/dia" → o eco lista as
  duas mudanças; um "sim" aplica ambas.
- **"vira Otimizador"** (`reseed_archetype`) → eco avisa que reseta persona/tom/
  metodologia/autonomia pros padrões do preset, mantendo meta/contexto/orientações.
- **Playbook**: "pausa anúncio que custa mais de R$50 por venda" → eco em
  linguagem de gente + confirma → cria a regra (fim da fila). "lista as regras" →
  numeradas com id; "desliga a regra 2" → eco + confirma.
- **Identidade**: "seu tom é mais direto" → atualiza o tom; "usa esse prompt: ..."
  (`set_system_prompt`) → eco avisa que substitui a metodologia do arquétipo.
- **Ambíguo** ("melhora a config") → o agente PERGUNTA, não aplica.
- **conversão personalizada sem id** → o agente responde pedindo qual conversão
  (não inventa).

## 3. Kill-switch (S2.3)
- Desligue `autonomy_policy.autoConfigViaChat = false` no agente (via DB ou uma
  futura UI). No chat, peça "muda a meta" → o agente responde que **config é pelo
  site** (as tools de config nem entram na allowlist). Operação (pausar/analisar/
  aprovar) segue funcionando por chat.

## 4. Autoconhecimento (S2.7)
- **"o que você consegue fazer?"** → `describe_capabilities` responde refletindo o
  contexto REAL: leitura; mexer nas campanhas SÓ se `allowedActions` permitir
  (senão diz que está desligado nos guardrails); config por chat SÓ se o
  kill-switch estiver ON (senão "pelo site"); autonomia por origem em PT; e
  "ainda não: criar campanhas". Nunca promete o que não pode.
- Concierge (org multi-conta sem foco) → visão geral + pede pra focar numa conta.

## 5. Foco troca a config (multi-conta)
- Org com ≥2 contas: "foca na Clínica X" → a partir do **próximo turno** a voz,
  `allowedActions` e o kill-switch passam a ser os do agente da Clínica X.

## Observações
- Toda escrita de config por chat = eco+confirma (§8) + org-scoping + audit
  (ator = contato). A ação confirmada é a CONGELADA no gate (o "sim" não
  re-especifica nada). Kill-switch é a governança de quem não quer config por chat.
- Fast-follows (ROADMAP): role-gating (só owner), playbook reordenar/janela,
  extrair playbook CRUD, modelo do chat por-agente, config proativa.
