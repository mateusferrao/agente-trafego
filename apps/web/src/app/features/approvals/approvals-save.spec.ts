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
  audience: null,
  applyPreview: { effect: 'real', message: null },
  ressalvas: null,
};

const AUDIENCE_APPROVAL: ApprovalOutput = {
  id: 'appr-aud',
  accountId: 'acc-1',
  accountName: 'Conta Teste',
  entityLevel: 'adset',
  entityId: 'as-1',
  entityName: 'Conjunto Y',
  type: 'adjust_audience',
  reason: 'público muito amplo — restringe a interessados em corrida',
  status: 'pending',
  expiresAt: null,
  currency: 'BRL',
  currentBudgetMajor: null,
  targetBudgetMajor: null,
  audience: {
    geo: [{ key: 'BR', name: 'Brasil', kind: 'country', radius: null, distanceUnit: null }],
    radiusAreas: [],
    ageMin: 25,
    ageMax: null,
    genders: null,
    interestGroups: [[{ id: 'i1', name: 'Corrida' }]],
    behaviorGroups: [],
    customAudienceIncludeIds: [],
    customAudienceExcludeIds: [],
  },
  applyPreview: { effect: 'real', message: null },
  ressalvas: null,
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

describe('ApprovalsPage — editar público de adjust_audience (Fatia C)', () => {
  let editSpy: jasmine.Spy;

  beforeEach(async () => {
    editSpy = jasmine.createSpy('editAction').and.returnValue(of({ id: 'appr-aud', status: 'pending' }));
    await TestBed.configureTestingModule({
      imports: [ApprovalsPage],
      providers: [
        provideRouter([]),
        {
          provide: ApprovalsApiService,
          useValue: {
            listPending: () => of([AUDIENCE_APPROVAL]),
            listRevertible: () => of([]),
            resolve: () => of({ id: 'appr-aud', status: 'approved' }),
            editAction: editSpy,
          },
        },
        {
          provide: DraftsApiService,
          useValue: {
            listPending: () => of([]),
            // usados pelo GeoAudienceEditor ao semear/editar (account-scoped).
            listAudiences: () => of([]),
            searchGeo: () => of([]),
            searchInterests: () => of([]),
            searchBehaviors: () => of([]),
            estimateDelivery: () => of({ note: null }),
          },
        },
        { provide: AnalysisApiService, useValue: { undoAction: () => of({}) } },
      ],
    }).compileComponents();
  });

  it('mostra "Editar público" e, ao salvar, chama editAction com explicitAudience', async () => {
    const fixture = TestBed.createComponent(ApprovalsPage);
    fixture.detectChanges();
    await flush();
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('Conjunto Y');
    const openBtn = findButton(fixture, 'Editar público');
    expect(openBtn).toBeTruthy();

    openBtn!.click();
    fixture.detectChanges();
    await flush();
    fixture.detectChanges();
    // aviso de reset de aprendizado presente.
    expect(fixture.nativeElement.textContent).toContain('reinicia o aprendizado');

    findButton(fixture, 'Salvar público')!.click();
    fixture.detectChanges();
    await flush();

    expect(editSpy).toHaveBeenCalledTimes(1);
    const [id, input] = editSpy.calls.mostRecent().args as [string, { explicitAudience?: { geo: unknown[] } }];
    expect(id).toBe('appr-aud');
    expect(input.explicitAudience).toBeTruthy();
    expect(input.explicitAudience!.geo.length).toBe(1); // Brasil semeado do proposto
  });
});
