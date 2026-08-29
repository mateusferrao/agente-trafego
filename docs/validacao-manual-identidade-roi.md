# Roteiro de validação manual — Identidade neobrutalista + agente Roy

Branch: `feat/brand-identity-roi`. Objetivo: conferir, passo a passo, a nova identidade visual (Bold Operational Desk), o agente **Roy** e a copy de marca — em **light e dark**.

## 0. Subir o ambiente

```bash
docker compose -f docker/docker-compose.yml up -d   # postgres + redis
pnpm db:migrate                                      # aplica migrations (inclui 0035: enum onboarding)
pnpm dev                                             # api (3333, serve web) + worker + web (4200)
```

**Já verificado automaticamente:** migrations aplicam em Postgres 16 (enum `run_trigger` = cron, on_demand, conversation, signal, **onboarding**); API `/health` 200; `/api/auth/me` retorna 401 correto sem sessão; `pnpm --filter web build` (AOT) + `pnpm --filter web tokens:check` verdes; core 361 testes + api 100 testes verdes; typecheck de db/shared/core/api/worker limpos.

## 1. Fundação visual (qualquer tela) — light + dark

Alterne o tema no shell (claro/escuro/sistema) e confira em cada modo:
- **Fontes:** títulos em **Space Grotesk**, corpo/UI em **Instrument Sans**, números/KPIs em **JetBrains Mono** (tabular).
- **Paleta:** fundo *paper* quente (claro) / navy profundo (dark); accent **caqui** raro; sucesso/agente **menta**; perigo **vermelho profundo** (distinto do caqui).
- **Botão primário:** navy sólido + **sombra offset** (caqui no claro, **menta** no dark) + "afundar" no hover (borda 2px). `Esperado`: passar o mouse desloca 3px e colapsa a sombra.
- **Sem glass/blur** como padrão; `tokens:check` não acusa cor hardcoded.
- **Ícones:** traço lucide (2px). Nenhum ✨ sparkles representando "IA".

## 2. Auth (sem login) — `/login`, `/signup`, `/verify-email`, `/forgot-password`, `/reset-password`
- Wordmark CaquiAI; primário navy+offset; erros de campo claros (o que aconteceu + o que fazer), sem stack.
- **Sem travessão** como conector na copy.

## 3. E-mails (marca robusta) — dispare cada um e abra no cliente
- **Verificação (OTP):** header com wordmark "Caqui**AI**" (AI em caqui), card branco, código destacado. Sóbrio.
- **Acesso liberado:** apresenta o Roy — *"Seu acesso está liberado. Entre e conheça o Roy, seu agente de tráfego."* + botão navy "Entrar agora". Sem "!".
- **Reset de senha / conta já existe:** sóbrios, sem citar Roy, sem travessão.
- `Esperado`: renderiza bem em Gmail/Outlook/Apple Mail (CSS inline + tabela; sem depender de fontes externas).

## 4. Onboarding + auto-análise (precisa de token Meta System User)
1. `/integrations` → conectar Meta → colar token → escolher conta(s) → concluir.
2. **`Esperado` (novo comportamento):** ao selecionar, dispara **automaticamente** a 1ª análise (run `trigger=onboarding`) e registra o schedule. Confira no worker log: `agent-run:execute` com a conta; e no banco `SELECT trigger,status FROM agent_runs ORDER BY created_at DESC LIMIT 1;` → `onboarding`.
3. Abra a conta → estado **"Roy está analisando sua conta"** com o **símbolo caqui pulsando** + narrativa de progresso (Puxando os números / Vendo onde o dinheiro foi / …). Reassurance honesta sobre o WhatsApp.
4. Sem conta conectada ainda, o empty state de `/accounts` e do Painel apresenta o Roy (aposto): *"…o Roy, seu agente de tráfego, …"*.

## 5. Identidade persistente do Roy
- No **cabeçalho da conta** (`/accounts/:id`): cartão de perfil (avatar com **anel de status** — verde ativo/âmbar pausado — + "Roy"), em linha própria acima dos botões Pausar/Analisar (não compete com eles como se fosse mais um controle).
- Copy: 1ª menção numa tela = "o Roy, seu agente de tráfego"; depois só "Roy".

## 6. Superfície em 2 níveis (Two-Tier)
- **Marca (bold):** empty states, cards de aprovação, momentos de decisão — borda 2px + offset.
- **Workspace (calmo):** tabelas/KPIs, config do agente, shell, custos — plano, borda fina, sem offset.

## 7. Aprovações — `/approvals`
- Empty state com Roy. Toasts sem travessão ("Enviado para aplicação. O agente aplica em instantes."). Status = tom + texto (nunca só cor). Seleção caqui × perigo (vermelho) sempre com ícone/rótulo.

## 8. Agente no WhatsApp (precisa de Evolution + contato verificado)
- Em DM e no concierge (org multi-conta), o agente **se apresenta como Roy**. Persona/tom seguem os do arquétipo/config (customizáveis) — só o **nome** é fixo.
- "digitando…" só aparece quando o Roy compõe resposta de conversa (não como loader de análise).

## 9. Acessibilidade
- Contraste AA (primário navy, textos, os dois vermelhos). Foco visível. `prefers-reduced-motion` desliga pulso/typing/skeleton/afundar.

## 10. Gates de regressão (rodar antes do merge)
```bash
pnpm --filter web tokens:check
pnpm --filter web build
pnpm --filter @trafego/core test
pnpm --filter @trafego/api test
pnpm typecheck   # ou por package: db, shared, core, api, worker
```

## Limitações desta rodada (precisam das suas credenciais)
Conexão Meta real (token System User), análise com dados reais, push no WhatsApp (Evolution) e render final dos e-mails em clientes reais não foram exercitados de ponta a ponta neste ambiente (sem credenciais). Os passos §4/§8/§3 acima cobrem esses fluxos para você validar.
