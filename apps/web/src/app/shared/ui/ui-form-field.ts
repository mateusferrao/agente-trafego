import { ChangeDetectionStrategy, Component, Input } from '@angular/core';

let uid = 0;

/**
 * Wrapper de campo de form: label + control (via projection) + hint/error.
 *
 * Uso:
 *   <app-ui-form-field label="Nome" hint="Obrigatório" [error]="form.controls.name.invalid && form.controls.name.touched ? 'Preencha o nome' : null">
 *     <input appInput formControlName="name" />
 *   </app-ui-form-field>
 *
 * O componente gera um `id` automático e expõe via slot `control[for]` pra
 * casos avançados; pra controls simples basta projetar e a label se associa
 * via wrapper.
 */
@Component({
  selector: 'app-ui-form-field',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <label class="flex flex-col gap-1.5" [attr.for]="fieldId">
      @if (label) {
        <span class="text-xs font-medium text-muted">
          {{ label }}
          @if (required) { <span class="text-tomato">*</span> }
        </span>
      }
      <ng-content />
      @if (error) {
        <span class="text-xs text-tomato">{{ error }}</span>
      } @else if (hint) {
        <span class="text-xs text-muted/80">{{ hint }}</span>
      }
    </label>
  `,
})
export class UiFormFieldComponent {
  @Input() label?: string;
  @Input() hint?: string;
  @Input() error?: string | null;
  @Input() required = false;
  readonly fieldId = `app-ff-${++uid}`;
}
