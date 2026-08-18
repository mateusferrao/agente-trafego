// Barrel do design system vendorizado (shared/ui). App code importa sempre de `@ui`.
// Subconjunto mínimo necessário para a Fatia 1a (login/signup, Contas, Config, shell).
// Ampliar conforme novas telas precisarem — ver VENDORING.md para o inventário completo.
export { UiButton } from './ui-button';
export { UiInput } from './ui-input';
export { UiFormFieldComponent as UiFormField } from './ui-form-field';
export { UiLabel } from './ui-label';
export { UiHint } from './ui-hint';
export type { UiHintTone } from './ui-hint';
export { UiBadge } from './ui-badge';
export { UiSpinnerComponent as UiSpinner } from './ui-spinner';
export { UiEmptyText } from './ui-empty-text';
export { UiEmptyStateComponent as UiEmptyState } from './ui-empty-state';
export { UiPageHeaderComponent as UiPageHeader } from './ui-page-header';
export { UiPanelCard, UiPanelGrid, UiPanelText, UiPanelTitle } from './ui-panel';
export { UiPulseDotComponent as UiPulseDot } from './ui-pulse-dot';
export { UiModuleSidebarComponent as UiModuleSidebar } from './ui-module-sidebar';
export type { UiModuleSidebarItem } from './ui-module-sidebar';
export { UiDialog, UiDialogOverlay, UiDialogTitle, UiDialogDescription } from './ui-dialog';
export { UiOptionRow, UiOptionRowCheck, UiOptionRowIcon, UiOptionRowCopy } from './ui-option-row';
