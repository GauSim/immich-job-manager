import { HttpClient, provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { MatSnackBar } from '@angular/material/snack-bar';
import {
  Router,
  provideRouter,
  type ActivatedRouteSnapshot,
  type RouterStateSnapshot,
  type UrlTree,
} from '@angular/router';
import { authGuard } from './auth.guard';
import { AuthStore } from './auth.store';
import { errorInterceptor } from './error.interceptor';

describe('auth (frontend)', () => {
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        provideRouter([]),
        provideHttpClient(withInterceptors([errorInterceptor])),
        provideHttpClientTesting(),
        { provide: MatSnackBar, useValue: { open: vi.fn() } },
      ],
    });
    http = TestBed.inject(HttpTestingController);
  });

  const runGuard = (url: string) =>
    TestBed.runInInjectionContext(() =>
      authGuard({} as ActivatedRouteSnapshot, { url } as RouterStateSnapshot),
    ) as Promise<boolean | UrlTree>;

  it('redirects to /login with the return URL when not signed in', async () => {
    const result = runGuard('/jobs/123');
    await Promise.resolve();
    http.expectOne('/api/auth/session').flush({ mode: 'password', authenticated: false });
    const tree = (await result) as UrlTree;
    expect(TestBed.inject(Router).serializeUrl(tree)).toBe('/login?returnUrl=%2Fjobs%2F123');
  });

  it('lets signed-in and forward-auth users through', async () => {
    const result = runGuard('/jobs');
    await Promise.resolve();
    http.expectOne('/api/auth/session').flush({ mode: 'forward-auth', authenticated: true });
    expect(await result).toBe(true);
  });

  it('sends the user to /login on 401 without an error snackbar', async () => {
    const router = TestBed.inject(Router);
    const navigate = vi.spyOn(router, 'navigate').mockResolvedValue(true);
    TestBed.inject(AuthStore).session.set({ mode: 'password', authenticated: true });
    TestBed.inject(HttpClient)
      .get('/api/jobs')
      .subscribe({ error: () => undefined });
    http
      .expectOne('/api/jobs')
      .flush({ message: 'Login required' }, { status: 401, statusText: 'Unauthorized' });
    expect(navigate).toHaveBeenCalledWith(['/login'], { queryParams: { returnUrl: '/' } });
    expect(TestBed.inject(AuthStore).session()?.authenticated).toBe(false);
    expect(TestBed.inject(MatSnackBar).open).not.toHaveBeenCalled();
  });
});
