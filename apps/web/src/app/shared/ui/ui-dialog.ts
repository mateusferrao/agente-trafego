import { DOCUMENT } from '@angular/common';
import { Directive, Injector, inject } from '@angular/core';
import {
  NgpDialog,
  NgpDialogDescription,
  NgpDialogOverlay,
  NgpDialogRef,
  NgpDialogTitle,
  type NgpDialogConfig,
} from 'ng-primitives/dialog';
import { provideExitAnimationManager } from 'ng-primitives/internal';

function createDeclarativeDialogRef() {
  const document = inject(DOCUMENT);
  const injector = inject(Injector);
  const dialogRef = new NgpDialogRef(
    {
      id: 'declarative-dialog',
      closeOnClick: false,
      closeOnOutsideClick: false,
    } satisfies NgpDialogConfig,
    document,
  );
  dialogRef.injector = injector;

  return dialogRef;
}

@Directive({
  selector: '[appDialogOverlay]',
  hostDirectives: [NgpDialogOverlay],
  providers: [provideExitAnimationManager(), { provide: NgpDialogRef, useFactory: createDeclarativeDialogRef }],
  host: {
    class: 'fixed inset-0 z-50 grid place-items-center bg-ink/30 p-4 backdrop-blur-sm',
  },
})
export class UiDialogOverlay {}

@Directive({
  selector: '[appDialog]',
  hostDirectives: [
    {
      directive: NgpDialog,
      inputs: ['id', 'ngpDialogRole', 'ngpDialogModal'],
    },
  ],
  host: {
    class: 'glass-surface w-full max-w-lg rounded-xl border border-line bg-panel p-5 text-ink shadow-panel',
  },
})
export class UiDialog {}

@Directive({
  selector: '[appDialogTitle]',
  hostDirectives: [NgpDialogTitle],
  host: {
    class: 'font-brand text-xl font-bold leading-tight text-ink',
  },
})
export class UiDialogTitle {}

@Directive({
  selector: '[appDialogDescription]',
  hostDirectives: [NgpDialogDescription],
  host: {
    class: 'mt-2 text-sm leading-6 text-muted',
  },
})
export class UiDialogDescription {}
