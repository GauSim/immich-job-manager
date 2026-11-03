import { Routes } from '@angular/router';

export const routes: Routes = [
  { path: '', pathMatch: 'full', redirectTo: 'jobs' },
  {
    path: 'jobs',
    pathMatch: 'full',
    title: 'Jobs · Immich Album Jobs',
    loadComponent: () => import('./pages/dashboard/dashboard').then((m) => m.Dashboard),
  },
  {
    path: 'jobs',
    loadChildren: () =>
      import('./pages/job-editor/job-editor.routes').then((m) => m.JOB_EDITOR_ROUTES),
  },
  {
    path: 'runs/:id',
    title: 'Run · Immich Album Jobs',
    loadComponent: () => import('./pages/run-detail/run-detail').then((m) => m.RunDetail),
  },
  {
    path: 'settings',
    title: 'Settings · Immich Album Jobs',
    loadComponent: () => import('./pages/settings/settings').then((m) => m.Settings),
  },
  { path: '**', redirectTo: 'jobs' },
];
