import type { Routes } from '@angular/router';
import { provideFormlyCore } from '@ngx-formly/core';
import { formlyConfig } from '../../shared/formly';
import { JobEditor } from './job-editor';

/** Lazy: Formly and its Material field types load only with the editor. */
export const JOB_EDITOR_ROUTES: Routes = [
  {
    path: '',
    providers: [provideFormlyCore(formlyConfig())],
    children: [
      { path: 'new', title: 'New job · Immich Album Jobs', component: JobEditor },
      { path: ':id', title: 'Job · Immich Album Jobs', component: JobEditor },
    ],
  },
];
