import { inject } from '@angular/core';
import { Router, type CanActivateChildFn } from '@angular/router';
import { AuthStore } from './auth.store';

/** Sends unauthenticated users to /login (password mode only). */
export const authGuard: CanActivateChildFn = async (_route, state) => {
  // Inject before the first await: inject() only works synchronously.
  const auth = inject(AuthStore);
  const router = inject(Router);
  const session = await auth.ensure();
  if (session.authenticated) return true;
  return router.createUrlTree(['/login'], { queryParams: { returnUrl: state.url } });
};
