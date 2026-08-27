import { AfterViewInit, Directive, ElementRef, OnDestroy, Renderer2, inject } from '@angular/core';

/**
 * Stepper on-brand para `<input type="number">` (substitui o spinner nativo, que é
 * cru e não-estilizável de forma consistente). Envolve o input num wrapper posicionado
 * e injeta dois botões (↑/↓) que chamam `stepUp`/`stepDown` (respeitam min/max/step) e
 * disparam `input`/`change` — então qualquer binding `(input)`/`(change)` existente
 * continua funcionando sem alteração. Apenas some o spinner nativo via CSS (.ui-stepper).
 *
 * Largura: inputs de largura fixa (classe `w-<n>`, ex. w-20) usam wrapper inline; os
 * `w-full` usam wrapper block 100%, preservando o layout de cada campo.
 */
const CHEVRON_UP =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m18 15-6-6-6 6"/></svg>';
const CHEVRON_DOWN =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>';

@Directive({
  selector: 'input[type=number][appNumberStepper]',
})
export class NumberStepper implements AfterViewInit, OnDestroy {
  private readonly host = inject<ElementRef<HTMLInputElement>>(ElementRef);
  private readonly renderer = inject(Renderer2);
  private readonly cleanups: (() => void)[] = [];
  private wrapper?: HTMLElement;

  ngAfterViewInit(): void {
    const input = this.host.nativeElement;
    const parent = input.parentNode as Node | null;
    if (!parent) return;

    const wrapper = this.renderer.createElement('span') as HTMLElement;
    this.renderer.addClass(wrapper, 'ui-stepper');
    // Copia a(s) classe(s) de largura do input pro wrapper (w-40, w-24, w-full…): o
    // wrapper passa a ter largura DEFINIDA igual à do input, então não é esticado pelo
    // flex do pai (align-items:stretch) e o stepper fica colado na borda do campo.
    for (const cls of input.className.split(/\s+/)) {
      if (/^w-/.test(cls)) this.renderer.addClass(wrapper, cls);
    }

    this.renderer.insertBefore(parent, wrapper, input);
    this.renderer.appendChild(wrapper, input);

    const ctrls = this.renderer.createElement('span') as HTMLElement;
    this.renderer.addClass(ctrls, 'ui-stepper__ctrls');
    this.renderer.appendChild(ctrls, this.makeButton('Aumentar', CHEVRON_UP, 1));
    this.renderer.appendChild(ctrls, this.makeButton('Diminuir', CHEVRON_DOWN, -1));
    this.renderer.appendChild(wrapper, ctrls);
    this.wrapper = wrapper;
  }

  private makeButton(label: string, svg: string, dir: 1 | -1): HTMLElement {
    const button = this.renderer.createElement('button') as HTMLButtonElement;
    this.renderer.setAttribute(button, 'type', 'button');
    this.renderer.setAttribute(button, 'tabindex', '-1');
    this.renderer.setAttribute(button, 'aria-label', label);
    this.renderer.addClass(button, 'ui-stepper__btn');
    this.renderer.setProperty(button, 'innerHTML', svg);
    this.cleanups.push(this.renderer.listen(button, 'click', () => this.step(dir)));
    return button;
  }

  private step(dir: 1 | -1): void {
    const input = this.host.nativeElement;
    if (input.disabled || input.readOnly) return;
    if (dir === 1) input.stepUp();
    else input.stepDown();
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    input.focus();
  }

  ngOnDestroy(): void {
    for (const cleanup of this.cleanups) cleanup();
    // Remove o wrapper que criamos (o input vai junto) — evita nós órfãos em re-render.
    if (this.wrapper?.parentNode) this.renderer.removeChild(this.wrapper.parentNode, this.wrapper);
  }
}
