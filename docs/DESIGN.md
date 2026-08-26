# DESIGN — AutoTraffic (IA, layout, linguagem visual)

Fonte da verdade de **design/UX**. Baseado nos padrões reais da plataforma **Automato** (`automato-web`) — reuso máximo, coerência total. Decisões de produto/arquitetura = [`../CLAUDE.md`](../CLAUDE.md). Construção = [`ROADMAP.md`](ROADMAP.md).

## North-star — "Bold Operational Desk"

Skin de marca **neobrutalista refinado** (bordas 2px, sombra sólida offset, paper quente, tomate + menta + navy) sobre um **núcleo operacional calmo** para o trabalho denso e sensível a dinheiro. **Manychat no espírito** (acessível, caloroso, sem jargão, chat-native — herdado do site `autotraffic`, NÃO do app Manychat nem do azul dele), **operacional na substância**. A IA é **infraestrutura embutida encarnada no agente Roi**, nunca um chatbot à parte nem glitter genérico. Detalhe completo de tokens/componentes = `apps/web/DESIGN.md`.

**Regras nomeadas (obrigatórias):**
- **Two-Tier Surface** — superfícies "Marca" (decisão/onboarding/conversa) levam a assinatura bold (borda 2px + offset ~3px); superfícies "Workspace" (tabelas/config/shell) ficam calmas e planas. Offset nunca em grid denso.
- **Brand Accent (tomate)** — tomate só p/ seleção/estado ativo/marca. >10% de tomate saturado = o accent parou de funcionar.
- **No Generic AI** — sem gradiente roxo-azul, glow neon, blob de "IA" nem ✨ sparkles. A identidade da IA é o Roi + o símbolo tomate.
- **Product Scale** — tipografia de produto (compacta), sem type de landing dentro do app.
- **Solid Layer** — a camada é a sombra sólida offset; blur só micro-elevação em overlays reais. Glass-como-padrão aposentado.
- **Personality Budget** — micro-encanto em loading/empty/sucesso/identidade do Roi; **proibido** em erro/dinheiro/dados densos.
- **Voz própria, sem cara de IA** — sem travessão dramático, "não é só X, é Y", tríades, hype, confete de "!", emoji-como-personalidade na UI. Tom por zona (Marca lúdico / Operacional neutro / Crítica preciso) + guardrail B2B (nada lúdico no que o gestor mostra ao cliente dele).
- **Status = tom + texto**, nunca só cor. Dois vermelhos (tomate marca × vermelho perigo) sempre com ícone+texto.

**Composição de tela:** `object header → área de trabalho → rail de contexto → trace de atividade/agente`. Todo workflow: ownership explícito, estado de ciclo de vida, próxima ação, status de automação, trilha de auditoria. WCAG AA, teclado, foco visível, i18n (PT-BR), light+dark desde o início.

Tokens/escala tipográfica/spacing = `apps/web/styles.css` + `apps/web/DESIGN.md`. Fontes: Archivo (display) + Instrument Sans (corpo) + JetBrains Mono (números). **Nunca cor hardcoded** — só design tokens.

## Arquitetura de Informação (account-centric)

- **Shell:** reusar o `app-shell` do Automato **verbatim** — grid sidebar+painel, nav agrupada, org switcher, command palette (Cmd/Ctrl+K), theme toggle (light/dark/system), `surface-noise`.
- **Objeto central = Conta** (ad account Meta). O **agente é entidade aninhada na conta** (1:1 hoje via unique FK; soltar o unique = N agentes/conta **sem re-arquitetura de IA** — a conta já é o container).
- **Módulos de topo:**

| Módulo | Papel |
|---|---|
| **Contas** (landing) | Núcleo: cada conta = conta Meta + seu agente. |
| **Aprovações** (inbox) | Caixa cross-account de pendências (espelha o WhatsApp). |
| **Integrações** | Canal WhatsApp da org (Evolution) + conectar nova conta Meta + saúde. |
| **Configurações** | Org, usuários, beta/assinatura, perfil, tema. |

(Sem Dashboard no MVP — Contas é a landing.)

## Telas

### Contas (landing)
`ui-page-header` ("Contas", count, `[Conectar conta]` primary) → `ui-filter-bar` (status + busca) → `ui-resource-grid` de **cards ricos**:
- nome da conta · status do agente (badge tom+texto) · status do token · KPIs (spend / CPA / ROAS últ. 7d) · nº de pendências · "analisado há X".
→ `ui-empty-state` no first-run ("Conecte sua primeira conta" + CTA).

### Conta (detalhe)
Header (`backLink`, nome, badges de status, ações) + **router-tabs** (house style Automato: `nav[appRouteTabs]` + `[appRouteTabPanel]` + `<router-outlet/>`):

- **Visão geral** — `ui-stat` (KPIs) + estado (agente ativo/pausado, token válido, próxima análise, pendências).
- **Agente** — **superfície única seccionada** (padrão builder Automato: `appUiLabel` eyebrow + `<h2>` + help + `form-grid`), semeada por **arquétipo**. Seções: Identidade → Meta (target CPA/ROAS) → Autonomia (slider `só avisa → sugere+OK → age no seguro → age sozinho`) → Segurança (guardrails) → Regras (playbook em **linguagem natural** com lacunas) → Cadência → `<details>` **Avançado**. **Save bar dirty** ("Alterações não salvas / Configuração salva"). **Zero-config** (arquétipo já funciona).
- **Timeline** — feed unificado de atividade (componente net-new, ver abaixo).
- **Conexões** — status Meta token (válido/inválido + recolar via connect-dialog) + **contato WhatsApp destinatário** da conta + **modo de operação** (padrão aba *Deployments* do Automato: status active/paused + autonomia).

### Aprovações (inbox)
`ui-record-list` cross-account de pendências. Cada linha = conta + ação(ões) proposta(s) + racional + `[Aprovar]`/`[Recusar]` **acionável** → mostra **eco concreto** + confirma → backend (guardrail + interrupt/resume). Filtro por conta/status. Espelha o fluxo do WhatsApp (caminho paralelo).

### Integrações
Padrão Automato:
- **Conectadas** — card do **canal WhatsApp da org** (health + número) + contas Meta conectadas.
- **Disponíveis** — Meta Ads, WhatsApp → via **connect-dialog + connector-strategy** (reusa connector `meta-ads`; **novo connector `evolution-whatsapp`** p/ QR/status).
- "Meus Canais" = instância Evolution.

### Configurações
Org, usuários (self-signup + membros), beta/assinatura, perfil, tema. Reusa o padrão de settings do Automato.

## Onboarding (first-run)

Contas vazio → CTA → **connect-dialog** (state machine `intro → credentials → connecting → success → error`): colar token → validar (trata erro 190) → **listar contas** (`GET /me/adaccounts`) → escolher → agente **auto-semeado** pelo arquétipo default. Ao selecionar, **dispara a 1ª análise automaticamente** (trigger `onboarding`) — o momento de valor. A tela de **sucesso apresenta o Roi** (beat não-bloqueante, sem passo extra) e é **state-aware do WhatsApp**: conectado → *"O Roi já está analisando {conta} e te avisa no WhatsApp"*; não conectado → *"O resultado aparece aqui. Conecte seu WhatsApp para o Roi te avisar por lá também"* + CTA. Depois, prompt conectar **WhatsApp** (Integrações, QR). Texto de privacidade: *"não armazenamos sua senha — só o token de acesso autorizado"*.

## Componente net-new — `ui-timeline`

Não existe no Automato (greenfield). Feed vertical **agrupado por dia**; cada evento = ícone (por tipo) + título + detalhe + **status badge (tom+texto)** + timestamp. Segue o ritmo do `ui-record-list` + guidance "compact activity trace" do DESIGN.md do Automato.

Tipos de evento: `analysis_started` · `analysis_completed` · `recommendation_created` · `approval_requested` · `approval_approved` · `approval_rejected` · `approval_expired` · `action_applied` · `action_rolled_back` · `error`.

## Princípios de UX (invariantes — skills e revisão referenciam aqui)

- **Erros sempre tratados e amigáveis:** nunca vazar exceção/stack/código técnico pro usuário. Toda falha vira mensagem clara.
- **Erro = o que aconteceu + o que fazer:** 1 frase, sem "Error:", sem culpa técnica. Ex: *"Não consegui conectar sua conta Meta. Verifique se o token está válido e cole de novo."*
- **Foco no não-técnico:** sem jargão; traduzir termos (CPA, adset, token) quando aparecerem.
- **Sempre mostrar o que está acontecendo:** loading/progresso/vazio/sucesso claros. Usuário nunca no escuro (ex: *"Analisando sua conta… ~1 min"*).
- **Sempre o próximo passo:** empty states e confirmações apontam a ação.
- **Voz:** sentence case; sem "please"; status = tom+texto. **Voz própria, sem cara de IA** (sem travessão dramático, "não é só X, é Y", hype, confete de "!", jargão de IA). **Tom por zona:** Marca lúdico (voz própria, ex.: *"Bora conectar sua conta Meta?"*), Operacional neutro (*"Configuração salva"*), Crítica preciso (*"Não consegui validar seu token da Meta. Confira se ele está ativo e cole novamente."*). Guardrail B2B: nada lúdico no que o gestor mostra ao cliente dele.
- **Agente = Roi** (nome de marca fixo em toda a org — contas + concierge; persona/tom customizável por conta, só o nome é fixo). 1ª menção numa tela qualifica (*"o Roi, seu agente de tráfego"*), depois só *"Roi"*; identidade visual persistente (símbolo tomate + "Roi").

## Mapa de reuso (Automato → nosso)

**Vendorizar** (copiar de `automato-web/src/app/shared/ui` + shell): `app-shell`, `ui-page-header`, `ui-section-header`, router-tabs, `ui-filter-bar`(+chips), `ui-resource-grid`/`card`, `ui-record-list`, `ui-data-table`, `ui-empty-state`, `ui-stat`/`ui-meter`, `ui-detail-drawer`, `ui-form-field`/`ui-select-field`/`ui-switch`/`ui-range`, `ui-badge`, **connect-dialog + connector-strategy** (registry + connector `meta-ads`), e o **padrão da aba Deployments** (→ nossa aba Conexões). Ver `apps/web/src/app/shared/ui/VENDORING.md`.

**Net-new (construir):** `ui-timeline` + connector `evolution-whatsapp`.

## Criação de campanhas (roadmap pós-MVP) — telas e fluxos

Vis: gestor completo no WhatsApp (otimiza **+ cria**). Ver `ROADMAP.md` → Fatia 7.

- **Aba "Criativos" na Conta** (nova): `ui-resource-grid` de assets da Creative Library — preview + origem (`reuse`/`upload`) + status Meta (image_hash/video_id). Upload no painel + reuse de vencedores. (Assets são por ad account.)
- **Intake de mídia no WhatsApp:** usuário manda a imagem **no chat** → agente confirma e vira asset na library ("Recebi seu criativo. Guardei em X.").
- **Card de aprovação de rascunho de campanha** (mais rico que 1 ação): estrutura (objetivo/budget/targeting/placement) + **preview do criativo** + **copy** + **budget novo** destacado → `[Aprovar]`/`[Editar]`/`[Recusar]`. No inbox Aprovações **e** espelhado no WhatsApp (eco concreto). **Aprovação obrigatória por default** (gasto novo).
- **Gatilhos:** "cria uma campanha…" no chat (Grafo B) + **proposta proativa** do agente (pelo que observou) — aparece na Timeline e no inbox.
- **Timeline** ganha eventos: `campaign_draft_proposed`, `campaign_created`.
- **Onboarding p/ criação:** capturar a **Page** do cliente (necessária p/ o anúncio).
- **Net-new de design:** tela Creative Library + card de rascunho de campanha (draft card). Geração de criativo por IA = fase mais tardia.

## Mapeamento telas × fatias (ROADMAP)

- Shell + login/signup + Contas landing (skeleton) → `1a`.
- Onboarding connect-dialog (Meta) → `1b`; WhatsApp (Integrações QR) → `5b`/`6b`.
- Conta detalhe / Agente (config) → `4`. Visão geral (KPIs) → `3`/`4`.
- Aprovações inbox → `5b`. Timeline → `6a`. Conexões (token status + modo) → `1b`/`5b`.
- **Criação (Fatia 7, pós-MVP):** Criativos (library) · card de rascunho de campanha · intake mídia WhatsApp · Page.
