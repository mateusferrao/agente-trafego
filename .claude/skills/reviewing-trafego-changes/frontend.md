# Revisar — Aderência Frontend (Angular)

Checklist de aderência (além do `/code-review`). Violação = candidato a **bloqueia**. Fonte: `CLAUDE.md` + `apps/web/DESIGN.md`.

## Design system / tokens

- [ ] **Sem cor/valor hardcoded:** nada de hex/rgb/hsl solto, `bg-blue-500` cru, sombra/raio/fonte fora do token. Só variáveis do design system. Rodar `pnpm --filter web tokens:check` — **falhou = bloqueia**.
- [ ] **Reuso de UI:** usa `shared/ui` antes de criar componente novo. Componente novo que duplica um existente → sinalizar.

## Angular

- [ ] **Standalone + signals:** sem NgModule; estado em signals; sem padrões legados.
- [ ] **Client tipado:** consumo da API pelo client kubb (`core/api`), não `fetch`/HttpClient manual duplicando tipos. Contrato mudou? `pnpm api:generate` rodado.
- [ ] **Separação de interesses:** template/estado/serviço separados; componente enxuto; lógica de dado fora do template.

## Princípios de engenharia (CLAUDE.md → Convenções)

- [ ] **Funções/métodos enxutos e legíveis**, nomes claros, PT-BR.
- [ ] **Desacoplamento + nomenclatura durável:** feature não acopla em detalhe de outra (comunicação por contrato); **nomes** (componente/serviço/rota/campo) não vazam fase/provider/detalhe de impl — trocar impl/sair da fase não exige renomear o conceito. Ver CLAUDE.md → *Nomenclatura no nível certo de abstração*.
- [ ] **Sem string mágica:** rotas, chaves, labels repetidos → const/i18n.

## UX / copy (aderência — `docs/DESIGN.md`) — violação = candidato a **bloqueia**

- [ ] **Exceção crua vazando** pro usuário (stack/código/`Error:`) → bloqueia. Erro = amigável + o que fazer.
- [ ] **Estado ausente:** faltou loading/vazio/sucesso? Empty state sem CTA de próximo passo? → sinalizar.
- [ ] **Jargão** sem tradução (CPA/adset/token) → sinalizar.
- [ ] **Status só por cor** (sem texto no badge) → bloqueia (acessibilidade).
- [ ] **Rare Accent** (emerald só p/ decisão/seleção) e **No Generic AI** (sem gradiente roxo-azul/glow/blob) respeitados.

## Acessibilidade (básico)

- [ ] Ícone-só com `aria-label`; foco visível; contraste vem dos tokens.
