# Validação manual — Fatia 7 (criação de campanhas, escala/duplicação, copy IA, proativo, Creative Library, intake)

> Roteiro **prático, passo a passo**. Cada bloco tem: **pré-condição → passos → resultado esperado → como verificar**. Cobre caminho **feliz** e **triste**, nos dois canais (**WhatsApp** e **site**).
> Convenção: `✅` = deve passar · `⛔` = caminho triste (deve falhar de forma amigável, sem quebrar).
> **Segurança:** tudo que criar na Meta nasce **PAUSED** (nunca veicula). No fim, o §15 reverte tudo (pausa/deleta). Nunca mexa na campanha real `[01][ABO][Leads][Advtg][Whatsapp]` — só leitura/origem.

---

## 0. Subir o ambiente

Pré: Docker rodando (postgres + redis), Node ≥22, pnpm.

```bash
cd C:\dev\agente-trafego
docker ps            # confirmar docker-postgres-1 e docker-redis-1 "Up"
pnpm install
pnpm db:migrate      # aplica migrations (0036/0037 da Fatia 7 incluídas)
pnpm dev             # sobe api (:3333) + worker + web (:4200) em paralelo
```

Verificar:
- `✅` API viva: abrir `http://localhost:3333/health` (ou o log "api up").
- `✅` Worker vivo: no log do worker deve aparecer `worker up: ... whatsapp-inbound + whatsapp-transcription + whatsapp-media-intake + mail`.
- `✅` Web: abrir `http://localhost:4200`, logar.

Se o login pedir acesso (allowlist beta):
```bash
pnpm access:grant seu-email@dominio.com
```

---

## 1. Conectar um token Meta VÁLIDO (crítico — não pule)

> O banco pode ter um token **stale** (o E2E revelou isso). Sem token válido, tudo que fala com a Meta falha com "token/app inválido".

Passos:
1. Site → **Integrações**.
2. Colar o **System User token de app publicado** do BM-Automato (o app precisa estar associado ao BM — §9). Gerar em: BM → Configurações → Usuários do sistema → *Plataforma Automato* → **Gerar token** (com BM-Automato + Página + Pixel atribuídos).
3. Salvar → o app valida e lista as contas → escolher **BM - Automato**.

Verificar:
```bash
docker exec docker-postgres-1 psql -U postgres -d trafego -t -c \
"select ad_account_id, currency, token_status, activity_state from ad_accounts where ad_account_id='1423420276172802';"
```
- `✅` `token_status = valid`.
- `⛔` Token inválido/expirado → banner no site "token expirou, reconecte" + `token_status=invalid` (não deve quebrar a tela).

---

## 2. Habilitar a criação (config do agente) — SITE

Pré: conta conectada. Rota: **Contas → (BM-Automato) → aba Agente**.

Passos:
1. Seção **Autonomia** → deve dizer, em frase, que *criar/escalar pedem sua aprovação* (não é toggle).
2. Abrir **Opções avançadas** → lista **por-ação**: ligar `create_campaign` e `duplicate_scale` (bindings). Ao afrouxar a autonomia de uma criação, deve aparecer **alerta proporcional ao risco** (from_scratch+copy-IA = alerta mais forte que duplicate).
3. Seção **Segurança/Limites → Limites de criação (gasto novo)**: definir `Orçamento novo máx./dia`, `Máx. campanhas novas/dia`, `Passo de escala (%)`.
4. ~~Seção **Notificações** → ligar **Rascunhos proativos**~~ — **Fatia D: criação proativa é SEMPRE ativa** (config `proactiveDrafts` removida; não há mais o que ligar).
5. Salvar.

Verificar:
- `✅` O símbolo de moeda ao lado de "Orçamento novo máx./dia" segue a moeda da conta (BRL → `R$`; conta USD → `$`) — **não** fica "R$" fixo.
- `✅` Recarregar a página mantém os valores (persistiu).
```bash
docker exec docker-postgres-1 psql -U postgres -d trafego -c \
"select max_new_daily_budget_minor, max_new_campaigns_per_day, scale_pct from guardrail_configs;"
docker exec docker-postgres-1 psql -U postgres -d trafego -c \
"select agent_id, tool_key, mode from agent_tool_bindings where tool_key in ('create_campaign','duplicate_scale');"
```
- `✅` Kill-switch: em **Segurança**, ligar `kill_switch` → depois nenhuma criação deve aplicar (ver §10).

---

## 3. Creative Library — upload web (S4)

Pré: aba **Criativos** da conta.

Passos:
1. Rota: **Conta → aba Criativos**.
2. `✅` Se a conta já rodou análise, os criativos dos anúncios aparecem (origem "Da conta").
3. Clicar **Subir imagem** (é um **botão** — testar via **teclado**: Tab até ele + Enter deve abrir o seletor) → escolher um `.png`/`.jpg`.
4. Aguardar "Enviando…".

Resultado esperado:
- `✅` Toast "imagem enviada — já dá pra reusar num rascunho".
- `✅` Card novo com origem **"Enviado"**, formato **"imagem"** (PT, não "image"), status **"pronto"**, e o `image_hash`.
- `✅` Re-selecionar **o mesmo arquivo** dispara upload de novo (input reseta).

Verificar:
```bash
docker exec docker-postgres-1 psql -U postgres -d trafego -c \
"select origin, format, status, meta_image_hash is not null as tem_hash from creative_assets order by created_at desc limit 3;"
```
- `⛔` Derrubar a API e recarregar a aba → deve aparecer **estado de erro com "Tentar de novo"** (NÃO o empty-state "nenhum criativo").

---

## 4. Intake de mídia — WhatsApp (S5)

Pré: instância Evolution conectada (número da org) + você é **contato verificado**. Conta em foco resolvida (org de 1 conta OU foco setado).

Passos:
1. No WhatsApp da org, **mandar uma imagem** (com ou sem legenda).
2. Aguardar.

Resultado esperado:
- `✅` Resposta: *"imagem guardada na biblioteca de criativos da {conta} — já dá pra usar num rascunho de campanha."*
- `✅` A imagem aparece na aba **Criativos** (origem "Enviado").
- `✅` NÃO dispara turno de conversa (é side-effect + cortesia, não vira análise).

Verificar:
```bash
docker exec docker-postgres-1 psql -U postgres -d trafego -c \
"select origin, format, status from creative_assets where origin='upload' order by created_at desc limit 3;"
```

Caminhos tristes:
- `⛔` **Org com 2+ contas e sem foco** → resposta: *"recebi sua imagem! só me diz de qual conta ela é…"* (pede a conta, não sobe). Setar foco (ex: "foca na conta X") e reenviar.
- `⛔` Mandar imagem de **número desconhecido** (não-verificado) na DM → **silêncio** (nada de resposta).
- `⛔` Reenviar a **mesma imagem** → não duplica asset (idempotente por conta+`image_hash`).

---

## 5. Escalar vencedor — SITE (1-clique) (S2c)

Pré: conta com pelo menos um "vencedor" (ou use qualquer campanha ativa como alvo).

Passos:
1. Rota: **Aprovações** (`/approvals`) OU detalhe da conta.
2. No card de um vencedor, clicar **"Escalar este vencedor"**.
3. Deve **abrir um rascunho PROPOSTO** (não aplica direto) — revisar: gasto novo/dia + Página + Pixel + ativação + se é **subir budget** ou **duplicar** (o eco explica o porquê).
4. `[Editar]` o orçamento se quiser → `[Aprovar]`.

Resultado esperado:
- `✅` Rascunho aparece em **Aprovações → "Rascunhos de campanha"** com "Gasto novo: R$ X/dia" (moeda da conta).
- `✅` Aprovar → re-check fresco do guardrail → saga aplica → status vira **criado**.
- `✅` **Passo pequeno** (≤ `scale_pct` dentro da faixa) → **sobe o budget** do vencedor. **Passo agressivo** → **duplica** pra isolar. O eco diz qual e por quê.
- `✅` (CBO) o eco promete o **valor real** já clampado à faixa segura (não promete +50% e aplica +20%).

Verificar:
```bash
docker exec docker-postgres-1 psql -U postgres -d trafego -c \
"select kind, status, origin, (spec->>'dailyBudgetMinor') as budget from campaign_drafts order by created_at desc limit 3;"
```

---

## 6. Escalar vencedor — WhatsApp (S2c/S3)

Passos:
1. Mandar: **"escala o vencedor"** (ou "escala a campanha X").
2. O agente responde com **eco concreto** (o quê/quanto/Página/Pixel/ativa-ou-pausada) e **espera confirmação**.
3. Responder **"sim"** (ou "pode").

Resultado esperado:
- `✅` Antes de qualquer escrita: **eco + espera confirmação**. Nunca aplica em interpretação incerta.
- `✅` "sim" → *"criando…"* → depois o desfecho é **empurrado** na conversa (aplicado/barrado).
- `✅` Referência inequívoca aplica; **ambíguo** ("escala aí") → o agente **pergunta qual**.
- `✅` Mesma verdade nos 2 canais: o rascunho/approval aparece também em **Aprovações** no site.

Caminho triste:
- `⛔` Responder **"não"/"cancela"** → não aplica, descarta a pendência.

---

## 7. Criar do zero + refinamento 100% ajustável — WhatsApp (S3)

Passos:
1. Mandar: **"cria uma campanha de vendas reusando o criativo X"** (ou "cria uma campanha de leads").
2. O agente propõe **defaults** (objetivo inferido da meta/conta, Página/Pixel inferidos, orçamento, N variações de **copy gerada por IA**) + eco.
3. **Antes de aprovar, personalizar conversando** (o "100% ajustável"):
   - "muda o orçamento pra R$ 30/dia"
   - "deixa 3 variações de copy"
   - "troca o criativo pelo Y"
   - "regenera as copies com tom mais direto"
   - "cria pausada" (override de ativação)
4. A cada ajuste, o agente **re-ecoa o rascunho atualizado**.
5. "sim" → cria (saga: campanha → adset → por variação: criativo + anúncio), tudo **PAUSED**.

Resultado esperado:
- `✅` Objetivo: usa a **meta do agente** (`conversionGoal`); senão infere da conta; **sempre confirma**.
- `✅` Página/Pixel **inferidos** e mostrados no eco. >1 Página → pergunta. Conta **sem anúncio** → bloqueia e pede.
- `✅` Copy: texto principal + título + descrição + **CTA neutro**, tom sóbrio B2B; **editável e regenerável**.
- `✅` `adjust_draft`/`regenerate_copy` mudam o rascunho persistido e o eco reflete.

Verificar:
```bash
docker exec docker-postgres-1 psql -U postgres -d trafego -c \
"select kind, status, (spec->>'variantsCount') as vars, jsonb_array_length(coalesce(spec->'copyVariants','[]')) as copies from campaign_drafts where kind='from_scratch' order by created_at desc limit 2;"
```

Caminhos tristes:
- `⛔` **goal inválido** (ex: "cria campanha de xpto") → não persiste objetivo inválido; infere/confirma o real (não vira objetivo silencioso errado).
- `⛔` Conta **sem Página/anúncio** inferível → bloqueia com mensagem clara pedindo a Página.
- `⛔` `create_campaign` **desligado** nos bindings (§2) → o agente recusa na hora ("não faço isso hoje").

---

## 8. Aprovação de rascunho — site + WhatsApp

**Site:**
1. **Aprovações → Rascunhos de campanha** → `[Aprovar]` / `[Recusar]`.
2. `✅` Aprovar = re-check fresco no apply. Barrado → status **`blocked`** + motivo visível.

**WhatsApp:**
1. Após um nudge/proposta, mandar **"aprova"** (ou "aprova o rascunho de escala").
2. `✅` Referência inequívoca aplica direto; ambíguo → pergunta.
3. `✅` O apply-service re-checa fresco e **empurra o desfecho** na conversa.

Caminho triste:
- `⛔` **Apply concorrente** (aprovar no site E no WhatsApp na mesma janela) → aplica **só uma vez** (claim atômico); a 2ª tentativa responde "já está sendo aplicado" — **NÃO cria campanha em dobro**.
- `⛔` Rascunho **expira em 24h** sem resposta → some da lista.

---

## 9. Proatividade de criação (S6)

Pré: conta com um vencedor OU sem campanha ativa (cold_start) — criação proativa é sempre ativa (Fatia D).

Passos:
1. Site → **Analisar agora** (ou esperar o cron) na conta.
2. Aguardar o run terminar.

Resultado esperado:
- `✅` Se houver oportunidade (escalar vencedor / refrescar fadiga / cold_start), nasce um **rascunho como recomendação** + **nudge** no WhatsApp.
- `✅` O rascunho proativo aparece em **Aprovações** e na **Timeline** (`campaign_draft_proposed`).
- `✅` Throttle: no máximo **1 rascunho proativo pendente por conta**.
- `✅` NUNCA auto-aplica — sempre pede aprovação.

Verificar:
```bash
docker exec docker-postgres-1 psql -U postgres -d trafego -c \
"select origin, status, kind from campaign_drafts where origin='proactive' order by created_at desc limit 3;"
```

---

## 10. Guardrails de gasto novo

Passos:
1. Em **Segurança → Limites de criação** (§2), pôr `Orçamento novo máx./dia` **baixo** (ex: R$ 5).
2. No WhatsApp, pedir criar/escalar com **orçamento acima** do teto (ex: R$ 50/dia) → aprovar.

Resultado esperado:
- `✅` No apply, o guardrail **clampa** pro teto (ou barra se exceder cap de campanhas/dia). O desfecho é honesto.
- `✅` `Máx. campanhas novas/dia` atingido → próximo apply do dia é **barrado** com motivo.
- `⛔` **Kill-switch ligado** → toda criação é **barrada** (`blocked`), mesmo aprovada.
- `✅` **Afrouxamento** (autonomia da criação no avançado) → aplica sem eco, mas o **guardrail continua** de rede + alerta foi mostrado ao afrouxar.

Verificar: o status do draft vira `blocked`/`failed` com motivo; nada é criado na Meta.

---

## 11. Undo (reverter criação)

Pré: um rascunho **criado** (§5/§6/§7).

Passos:
1. WhatsApp: "desfaz a última campanha que você criou" (ou pelo site, se houver o controle).

Resultado esperado:
- `✅` As entidades criadas são **PAUSADAS** (via `createdIds`) — **nunca deletadas** — e o draft vira `reverted`.
- `✅` Confirmação na conversa.

Verificar:
```bash
docker exec docker-postgres-1 psql -U postgres -d trafego -c \
"select status, created_ids from campaign_drafts where status='reverted' order by updated_at desc limit 2;"
```

---

## 12. Timeline

Rota: **Conta → aba Timeline**, filtro **Campanhas**.
- `✅` Evento **"Nova campanha proposta"** / **"Escala de vencedor proposta"** (badge "rascunho") com "R$ X/dia" na **moeda da conta**.
- `✅` Evento **"Campanha criada"** / **"Escala criada"** (badge "criada") após aprovar.

---

## 13. Caminhos tristes consolidados (checklist rápido)

- `⛔` Token inválido → banner + `token_status=invalid`, telas não quebram.
- `⛔` Conta sem Página/anúncio → criação bloqueada com pedido claro.
- `⛔` goal inválido no chat → não vira objetivo errado.
- `⛔` `create_campaign`/`duplicate_scale` desligado → recusa honesta na hora.
- `⛔` Guardrail estoura / kill-switch → `blocked`/`failed` com motivo; nada criado.
- `⛔` Apply concorrente (chat+site) → aplica 1×, não duplica gasto.
- `⛔` Imagem de desconhecido (DM) → silêncio. Sem foco de conta → pede a conta.
- `⛔` Saga falha no meio → status `failed` + motivo; **retry** retoma por `createdIds` (não recria o que já existe); ou descarta.
- `⛔` Fetch da Creative Library falha → estado de erro com "Tentar de novo" (não empty-state).
- `⛔` **Duplicar adset LEGADO** (com "aprimoramentos padrão"/standard_enhancements) → a Meta rejeita (limitação dela, subcode 3858504). Hoje aparece como falha genérica; **fast-follow** = mensagem clara + recair em subir budget. Duplicar adset **novo/limpo** funciona.

---

## 14. Transparência (invariante 12) — checklist

- [ ] Todo eco antes de escrita descreve **o quê / quanto / Página / Pixel / ativa-ou-pausada**.
- [ ] Jargão traduzido (CPA, adset, pixel → linguagem de gente).
- [ ] Proposta **proativa** vem rotulada + com o porquê.
- [ ] Bloqueio explica **o limite + a saída**.
- [ ] Mesmos estados/verdade nos **dois canais** (site e WhatsApp).
- [ ] Erros = o que aconteceu + próximo passo (sem stack/código técnico).

---

## 15. Limpeza (reverter tudo que o teste criou na Meta)

> Tudo nasceu PAUSED; ainda assim, remova o que criou.

- Undo pelo chat (§11) pausa as entidades criadas, OU
- No **Gerenciador de Anúncios** da BM-Automato, filtrar por nome (as criadas de teste) e **excluir**.
- **Rotacionar o token** de teste na Meta (BM → Usuários do sistema → *Plataforma Automato* → **Anular tokens** → gerar outro pro uso real) — o de teste ficou exposto.

Conferir que não sobrou nada ativo:
```bash
docker exec docker-postgres-1 psql -U postgres -d trafego -c \
"select kind, status, origin from campaign_drafts order by created_at desc limit 10;"
```

---

### Referência rápida — consultas DB úteis
```bash
# rascunhos
docker exec docker-postgres-1 psql -U postgres -d trafego -c "select id,kind,status,origin,created_at from campaign_drafts order by created_at desc limit 10;"
# aprovações (ação × rascunho — união)
docker exec docker-postgres-1 psql -U postgres -d trafego -c "select id,status,(draft_id is not null) as eh_rascunho,action_type from approvals order by created_at desc limit 10;"
# criativos
docker exec docker-postgres-1 psql -U postgres -d trafego -c "select origin,format,status from creative_assets order by created_at desc limit 10;"
# tool_calls de criação (idempotência/rollback)
docker exec docker-postgres-1 psql -U postgres -d trafego -c "select tool_key,idempotency_key,risk from agent_tool_calls order by created_at desc limit 10;"
```
