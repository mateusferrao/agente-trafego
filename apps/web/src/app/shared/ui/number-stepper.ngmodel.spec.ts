import { Component, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { UiInput } from './ui-input';
import { NumberStepper } from './number-stepper.directive';

// COM diretiva (combo do editor de aprovações).
@Component({
  standalone: true,
  imports: [FormsModule, UiInput, NumberStepper],
  template: `
    <input
      appInput
      appNumberStepper
      type="number"
      [ngModel]="value()"
      (ngModelChange)="value.set($event)"
    />
  `,
})
class WithDirective {
  readonly value = signal<number | null>(null);
}

// COM diretiva DENTRO de @if (igual ao editor: abre/fecha) — testa o TEARDOWN.
@Component({
  standalone: true,
  imports: [FormsModule, UiInput, NumberStepper],
  template: `
    @if (open()) {
      <input appInput appNumberStepper type="number" [ngModel]="value()" (ngModelChange)="value.set($event)" />
    }
  `,
})
class InsideIf {
  readonly open = signal(true);
  readonly value = signal<number | null>(96);
}

// CONTROLE: mesmo binding, SEM appNumberStepper (só appInput).
@Component({
  standalone: true,
  imports: [FormsModule, UiInput],
  template: `
    <input appInput type="number" [ngModel]="value()" (ngModelChange)="value.set($event)" />
  `,
})
class WithoutDirective {
  readonly value = signal<number | null>(null);
}

function inputEl<T>(fixture: ComponentFixture<T>): HTMLInputElement {
  return fixture.nativeElement.querySelector('input') as HTMLInputElement;
}

/** flush de micro+macrotask (app é zoneless — NgModel escreve o valor num microtask). */
const flush = () => new Promise((r) => setTimeout(r, 0));

describe('prefill (signal → input) COM vs SEM appNumberStepper', () => {
  it('CONTROLE (sem diretiva): prefill reflete no input', async () => {
    const fixture = TestBed.configureTestingModule({ imports: [WithoutDirective] }).createComponent(WithoutDirective);
    fixture.detectChanges();
    fixture.componentInstance.value.set(42);
    fixture.detectChanges();
    await flush();
    expect(inputEl(fixture).value).toBe('42');
  });

  it('COM appNumberStepper: prefill reflete no input', async () => {
    const fixture = TestBed.configureTestingModule({ imports: [WithDirective] }).createComponent(WithDirective);
    fixture.detectChanges();
    fixture.componentInstance.value.set(42);
    fixture.detectChanges();
    await flush();
    expect(inputEl(fixture).value).toBe('42');
  });

  it('COM appNumberStepper: digitar atualiza o signal', () => {
    const fixture = TestBed.configureTestingModule({ imports: [WithDirective] }).createComponent(WithDirective);
    fixture.detectChanges();
    const input = inputEl(fixture);
    input.value = '96';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    fixture.detectChanges();
    expect(fixture.componentInstance.value()).toBe(96);
  });

  it('TEARDOWN: fechar o @if (como salvar/cancelar) não lança erro de DOM', () => {
    const fixture = TestBed.configureTestingModule({ imports: [InsideIf] }).createComponent(InsideIf);
    fixture.detectChanges(); // abre + ngAfterViewInit move o input
    expect(inputEl(fixture)).toBeTruthy();
    // fecha o editor — é aqui que o control-flow tenta remover os nós do bloco
    fixture.componentInstance.open.set(false);
    expect(() => fixture.detectChanges()).not.toThrow();
    expect(inputEl(fixture)).toBeNull();
  });

  it('TEARDOWN: destruir o componente com editor aberto não lança', () => {
    const fixture = TestBed.configureTestingModule({ imports: [InsideIf] }).createComponent(InsideIf);
    fixture.detectChanges();
    expect(() => fixture.destroy()).not.toThrow();
  });
});
