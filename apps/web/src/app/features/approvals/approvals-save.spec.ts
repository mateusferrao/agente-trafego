import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { of } from 'rxjs';
import { provideRouter } from '@angular/router';
import { ApprovalsPage } from './approvals-page';
import { ApprovalsApiService } from '@core/api/approvals-api.service';
import { DraftsApiService } from '@core/api/drafts-api.service';
import { AnalysisApiService } from '@core/api/analysis-api.service';
import type { ApprovalOutput } from '@core/api/generated';

const APPROVAL: ApprovalOutput = {
  id: 'appr-1',
  accountId: 'acc-1',
  accountName: 'Conta Teste',
  entityLevel: 'campaign',
  entityId: 'camp-1',
  entityName: 'Campanha X',
  type: 'adjust_budget',
  reason: 'reduzir 20% do budget',
  status: 'pending',
  expiresAt: null,
  currency: 'BRL',
  currentBudgetMajor: 120,
  targetBudgetMajor: 96,
};

const flush = () => new Promise((r) => setTimeout(r, 0));

function findButton(fixture: ComponentFixture<ApprovalsPage>, text: string): HTMLButtonElement | null {
  const buttons = Array.from(fixture.nativeElement.querySelectorAll('button')) as HTMLButtonElement[];
  return buttons.find((b) => (b.textContent ?? '').trim().includes(text)) ?? null;
}

describe('ApprovalsPage — salvar valor do ajuste de orçamento', () => {
  let editSpy: jasmine.Spy;
  let listSpy: jasmine.Spy;

  beforeEach(async () => {
    editSpy = jasmine.createSpy('editAction').and.returnValue(of({ id: 'appr-1', status: 'pending' }));
    listSpy = jasmine.createSpy('listPending').and.returnValue(of([APPROVAL]));
    await TestBed.configureTestingModule({
      imports: [ApprovalsPage],
      providers: [
        provideRouter([]),
        {
          provide: ApprovalsApiService,
          useValue: {
            listPending: listSpy,
            listRevertible: () => of([]),
            resolve: () => of({ id: 'appr-1', status: 'approved' }),
            editAction: editSpy,
          },
        },
        { provide: DraftsApiService, useValue: { listPending: () => of([]) } },
        { provide: AnalysisApiService, useValue: { undoAction: () => of({}) } },
      ],
    }).compileComponents();
  });

  it('mostra o card e o botão "Editar valor"', async () => {
    const fixture = TestBed.createComponent(ApprovalsPage);
    fixture.detectChanges();
    await flush();
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('Campanha X');
    expect(findButton(fixture, 'Editar valor')).toBeTruthy();
  });

  it('abrir editor pré-preenche com o proposto e o input mostra o valor', async () => {
    const fixture = TestBed.createComponent(ApprovalsPage);
    fixture.detectChanges();
    await flush();
    fixture.detectChanges();
    findButton(fixture, 'Editar valor')!.click();
    fixture.detectChanges();
    await flush();
    fixture.detectChanges();
    const input = fixture.nativeElement.querySelector('input[type=number]') as HTMLInputElement;
    expect(input).toBeTruthy();
    expect(input.value).toBe('96'); // targetBudgetMajor
  });

  it('digitar e clicar em "Salvar valor" chama editAction com o valor', async () => {
    const fixture = TestBed.createComponent(ApprovalsPage);
    fixture.detectChanges();
    await flush();
    fixture.detectChanges();
    findButton(fixture, 'Editar valor')!.click();
    fixture.detectChanges();
    await flush();
    fixture.detectChanges();

    const input = fixture.nativeElement.querySelector('input[type=number]') as HTMLInputElement;
    input.value = '80';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    fixture.detectChanges();

    const save = findButton(fixture, 'Salvar valor');
    expect(save).toBeTruthy();
    save!.click();
    fixture.detectChanges();
    await flush();

    expect(editSpy).toHaveBeenCalledTimes(1);
    expect(editSpy).toHaveBeenCalledWith('appr-1', { mode: 'set', budgetReais: 80 });
  });

  it('após salvar, recarrega as pendentes (o card reflete o novo proposto — não fica velho)', async () => {
    const fixture = TestBed.createComponent(ApprovalsPage);
    fixture.detectChanges();
    await flush();
    fixture.detectChanges();
    const listCallsAfterInit = listSpy.calls.count(); // ngOnInit já chamou uma vez

    findButton(fixture, 'Editar valor')!.click();
    fixture.detectChanges();
    await flush();
    fixture.detectChanges();
    const input = fixture.nativeElement.querySelector('input[type=number]') as HTMLInputElement;
    input.value = '80';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    fixture.detectChanges();
    findButton(fixture, 'Salvar valor')!.click();
    fixture.detectChanges();
    await flush();

    expect(listSpy.calls.count()).toBeGreaterThan(listCallsAfterInit);
  });
});
