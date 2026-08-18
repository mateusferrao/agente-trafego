# Vendorização do `shared/ui`

Este app **vendoriza** (copia física) a biblioteca de componentes do design system
Automato — não é um pacote npm compartilhado (o pacote `@automato/design-system` é
fast-follow — CLAUDE.md §2). O design system porta 1:1 para cá porque ambos são
Angular standalone + Tailwind 4 CSS-config (CLAUDE.md §4).

## Fonte (read-only — NÃO modificar lá)

```
C:\Users\mateu\OneDrive\Área de Trabalho\Automato\Plataforma AI Driven\automato-web\src\app\shared\ui\
```

## Destino

```
apps/web/src/app/shared/ui/
```

## Pré-requisitos já satisfeitos neste app

- `src/styles.css` — tokens (`--color-*`, `--radius-*`, `--shadow-*`, `--font-*`) e
  `@theme` do Tailwind 4. **Copiado** do projeto de referência.
- `DESIGN.md` — regras do design system. **Copiado**.
- `scripts/validate-design-tokens.mjs` + script `tokens:check`. **Copiado**.
- Fontes (Figtree / Plus Jakarta Sans / Noto Serif) carregadas no `index.html`.

## Dependência de runtime

Vários componentes usam **`ng-primitives`** (headless a11y). Já está declarada em
`package.json`. Confirme a versão contra a do projeto de referência antes de instalar.

## Como copiar (PowerShell)

```powershell
$src = "C:\Users\mateu\OneDrive\Área de Trabalho\Automato\Plataforma AI Driven\automato-web\src\app\shared\ui"
$dst = "apps\web\src\app\shared\ui"
# Copie os arquivos listados abaixo (comece pelo núcleo).
Copy-Item "$src\ui-button.ts" $dst
# ...repita conforme a ordem sugerida.
```

Depois de copiar, **substitua o `index.ts` placeholder** por uma cópia do barrel de
origem (ajustando conforme os arquivos efetivamente vendorizados) e rode:

```bash
pnpm --filter web tokens:check   # gate de tokens
pnpm --filter web typecheck
```

---

## Ordem sugerida de vendorização

### 1. Núcleo (traga primeiro — dependências dos demais)

| Arquivo | Exporta (barrel) |
|---|---|
| `ui-button.ts` | `UiButton` |
| `ui-icon-button.ts` | `UiIconButton` |
| `ui-action-surface.ts` | `UiAvatarButton`, `UiBackdropButton`, `UiMediaButton`, `UiTextButton` |
| `ui-badge.ts` | `UiBadge` |
| `ui-label.ts` | `UiLabel` |
| `ui-hint.ts` | `UiHint`, `UiHintTone` |
| `ui-panel.ts` | `UiPanelCard`, `UiPanelGrid`, `UiPanelText`, `UiPanelTitle` |
| `ui-spinner.ts` | `UiSpinner` |
| `ui-pulse-dot.ts` | `UiPulseDot` |
| `ui-empty-text.ts` | `UiEmptyText` |
| `ui-empty-state.ts` | `UiEmptyState` |
| `ui-skeleton.ts` | `UiSkeletonRow`, `UiSkeletonGrid`, `UiDetailHeaderSkeleton`, `UiDetailPageSkeleton`, `UiPanelSkeletonGrid` |

### 2. Shell / navegação (para o `layouts/app-shell`)

| Arquivo | Exporta |
|---|---|
| `ui-module-sidebar.ts` | `UiModuleSidebar`, `UiModuleSidebarItem` |
| `ui-page-header.ts` | `UiPageHeader` |
| `ui-section-header.ts` | `UiSectionHeader` |
| `ui-tabs.ts` | `UiTabs`, `UiTabList`, `UiTabButton`, `UiTabPanel`, `UiTabIndicator`, `UiRouteTabs`, `UiRouteTabLink`, `UiRouteTabPanel` |
| `ui-step-nav.ts` | `UiStepNav`, `UiStepPill`, `UiStepPillBadge`, `UiStepPillLabel` (onboarding) |

### 3. Formulários (para agents / onboarding / settings)

| Arquivo | Exporta |
|---|---|
| `ui-form-field.ts` | `UiFormField` |
| `ui-input.ts` | `UiInput` |
| `ui-form-controls.ts` | `UiSelect`, `UiNativeSelect`, `UiSelectDropdown`, `UiSelectOption`, `UiTextarea` |
| `ui-select-field.ts` | `UiSelectField`, `UiSelectFieldOption`, `UiSelectFieldValue` |
| `ui-date-field.ts` | `UiDateField` |
| `ui-checkbox.ts` | `UiCheckbox` |
| `ui-switch.ts` | `UiSwitch`, `UiSwitchThumb` (dry-run / kill-switch) |
| `ui-range.ts` | `UiRange` (slider de autonomia) |
| `ui-toggle-group.ts` | `UiToggleGroup`, `UiToggleGroupItem`, `UiToggleIndicator` (arquétipo) |
| `ui-icon-toggle-group.ts` | `UiIconToggleGroup`, `UiIconToggleGroupItem`, `UiIconToggleIndicator` |
| `ui-otp.ts` | `UiOtpRoot`, `UiOtpInput`, `UiOtpSlot`, `UiOtpSlots` |
| `ui-file-picker.ts` | `UiFilePicker`, `UiFileInput`, `UiFilePickerVariant` |
| `ui-option-row.ts` | `UiOptionRow`, `UiOptionRowCheck`, `UiOptionRowCopy`, `UiOptionRowIcon` |

### 4. Listas / tabelas / timeline (para accounts / timeline)

| Arquivo | Exporta |
|---|---|
| `ui-record-list.ts` | `UiRecordList`, `UiRecordRow`, `UiRecordRowTitle`, `UiRecordRowMeta`, `UiRecordRowMain`, `UiRecordRowBody`, `UiRecordRowDescription`, `UiRecordRowIcon`, `UiRecordRowActions`, `UiRecordRowButton` |
| `ui-data-table.ts` | `UiDataTable`, `UiDataTableShell`, `UiDataTableHead`, `UiDataTableRow`, `UiDataTableCell`, `UiDataTableHeaderCell`, `UiDataTableEmptyCell`, `UiDataTableActions` |
| `ui-resizable-columns.ts` | `UiResizableColumns` |
| `ui-sort-header.ts` | `UiSortHeader`, `UiSortChange`, `UiSortDirection` |
| `ui-resource-grid.ts` | `UiResourceGrid`, `UiResourceCard` (+ subcomponentes) |
| `ui-filter-bar.ts` | `UiFilterBar`, `UiFilterCluster`, `UiFilterField`, `UiFilterChip`, `UiFilterLabel`, `UiFilterSearch`, `UiFilterActions` |
| `ui-period-picker.ts` | `UiPeriodPicker`, `UiPeriodPreset` |
| `list-selection.ts` | `ListSelection` |
| `ui-bulk-bar.ts` | `UiBulkBar` (+ tipos) |
| `ui-bulk-action-bar.ts` | `UiBulkActionBar` (+ subcomponentes) |

### 5. Overlays / feedback / stats

| Arquivo | Exporta |
|---|---|
| `ui-dialog.ts` | `UiDialog`, `UiDialogOverlay`, `UiDialogTitle`, `UiDialogDescription` |
| `ui-drawer.ts` | `UiDrawer`, `UiDrawerOverlay`, `UiDrawerHeader`, `UiDrawerBody`, `UiDrawerFooter` |
| `ui-detail-drawer.ts` | `UiDetailDrawer`, `UiDetailDrawerWidth` |
| `ui-menu.ts` | `UiMenuPanel`, `UiMenuItem`, `UiMenuSeparator` |
| `ui-tooltip.ts` | `UiTooltip` |
| `ui-confirm-dialog.service.ts` + `ui-confirm-dialog-outlet.ts` | `UiConfirmDialogService`, `UiConfirmDialogOutlet`, `ConfirmDialogOptions`, `ConfirmDialogTone` |
| `ui-toast.service.ts` + `ui-toast-outlet.ts` (+ `.html`, `.css`) | `ToastrService`, `UiToastOutlet` |
| `ui-stat.ts` | `UiStat`, `UiStatDeltaTone`, `UiStatValueTone` |
| `ui-meter.ts` | `UiMeter`, `UiMeterSegment`, `UiMeterTone` |
| `ui-progress-bar.ts` | `UiProgressBar` |
| `ui-attainment-bar.ts` | `UiAttainmentBar` |
| `ui-lightbox.ts` | `UiLightbox` |

### 6. Utilitários / opcionais (traga se a feature precisar)

| Arquivo | Exporta / nota |
|---|---|
| `linkify.pipe.ts` | `LinkifyPipe`, `TextSegment` |
| `ui-channel-icon.ts` | `UiChannelIcon` (ícone de canal — útil p/ WhatsApp) |
| `ui-color-picker.ts` | `UiColorPicker`, `UiColorSwatch` (ignorado pelo `tokens:check`) |

### Specs (opcional, recomendado)

Cada componente com `*.spec.ts` na origem — copie junto se for manter a suíte de testes:
`linkify.pipe.spec.ts`, `ui-confirm-dialog-outlet.spec.ts`, `ui-confirm-dialog.service.spec.ts`,
`ui-detail-drawer.spec.ts`, `ui-dialog.spec.ts`, `ui-lightbox.spec.ts`, `ui-meter.spec.ts`,
`ui-resizable-columns.spec.ts`, `ui-toast-outlet.spec.ts`, `ui-toast.service.spec.ts`.

---

## Validação pós-cópia

1. `pnpm --filter web tokens:check` — nenhum valor visual hardcoded fora de `styles.css`.
   (o script ignora `core/api/generated/`, `*.spec.ts`, `*.service.ts`, `ui-color-picker.ts` etc.)
2. `pnpm --filter web typecheck` — sem erros de tipo (confirme `ng-primitives` instalado).
3. Atualize `index.ts` (barrel) para exportar exatamente o que foi vendorizado.
