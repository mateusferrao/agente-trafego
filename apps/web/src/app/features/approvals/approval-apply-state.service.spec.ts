import { TestBed } from '@angular/core/testing';
import { of } from 'rxjs';
import { ApprovalsApiService } from '@core/api/approvals-api.service';
import type { ApprovalOutcomeOutput } from '@core/api/generated';
import { ApprovalApplyStateService } from './approval-apply-state.service';

function makeApi(outcome: ApprovalOutcomeOutput) {
  return { resolve: () => of({ id: 'ap1', status: 'pending' }), getOne: () => of(outcome) } as unknown as ApprovalsApiService;
}

describe('ApprovalApplyStateService', () => {
  it('approve → poll resolve → mostra o desfecho e esconde botões (resolvido não-falha)', () => {
    const outcome: ApprovalOutcomeOutput = { id: 'ap1', status: 'approved', applyOutcome: 'applied', resolvedReason: null, outcomeMessage: 'Ajustei o orçamento de X.' };
    TestBed.configureTestingModule({ providers: [ApprovalApplyStateService, { provide: ApprovalsApiService, useValue: makeApi(outcome) }] });
    const svc = TestBed.inject(ApprovalApplyStateService);
    svc.approve('ap1');
    expect(svc.label('ap1')).toBe('Ajustei o orçamento de X.');
    expect(svc.isResolvedNonFailed('ap1')).toBe(true);
  });

  it('desfecho failed → mantém acionável (não esconde botões)', () => {
    const outcome: ApprovalOutcomeOutput = { id: 'ap1', status: 'pending', applyOutcome: 'failed', resolvedReason: null, outcomeMessage: 'Não consegui agora — tenta de novo.' };
    TestBed.configureTestingModule({ providers: [ApprovalApplyStateService, { provide: ApprovalsApiService, useValue: makeApi(outcome) }] });
    const svc = TestBed.inject(ApprovalApplyStateService);
    svc.approve('ap1');
    expect(svc.isResolvedNonFailed('ap1')).toBe(false);
    expect(svc.label('ap1')).toContain('tenta de novo');
  });
});
