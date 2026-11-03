# Frontend (Angular)

Angular 22 SPA (standalone components, signals, Angular Material). Built into the backend's `/public` in the Docker image.

```bash
npm ci
npm start             # http://localhost:4200
npm run lint
npm test              # Vitest via ng test
npm run build         # dist/frontend/browser
npm run e2e:prepare   # build UI + backend for the Playwright tests
npm run e2e           # Playwright smoke tests (real backend, fake Immich, 2,910 candidates)
```

`npm start` proxies `/api` to the backend on `localhost:3000` (`proxy.conf.json`).

Structure: `src/app/core` (API client, models, HTTP error interceptor, SSE, health), `src/app/shared` (confirm dialog, status chip, Formly types and the JSON-Schema params form), `src/app/pages` (dashboard, job editor, run detail, review grid, settings). Pages are lazy-loaded; Formly is provided only on the job-editor routes.

Design: [SDD §9](../docs/design/immich-album-jobs-SDD.md#9-frontend-angular).
