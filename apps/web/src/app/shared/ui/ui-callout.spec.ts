import { TestBed } from '@angular/core/testing';
import { UiCallout } from './ui-callout';

describe('UiCallout', () => {
  it('renderiza com role=status e a classe do tom', () => {
    const fixture = TestBed.createComponent(UiCallout);
    fixture.componentRef.setInput('tone', 'blocked');
    fixture.detectChanges();
    const span = fixture.nativeElement.querySelector('[role="status"]') as HTMLElement;
    expect(span).toBeTruthy();
    expect(span.className).toContain('bg-panel');
  });

  it('tom warning usa o token de warning (não cor hardcoded)', () => {
    const fixture = TestBed.createComponent(UiCallout);
    fixture.componentRef.setInput('tone', 'warning');
    fixture.detectChanges();
    const span = fixture.nativeElement.querySelector('[role="status"]') as HTMLElement;
    expect(span.className).toContain('border-warning');
  });
});
