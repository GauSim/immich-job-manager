import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { App } from './app';
import { AuthStore } from './core/auth.store';

describe('App shell', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [App],
      providers: [provideRouter([]), provideHttpClient(), provideHttpClientTesting()],
    }).compileComponents();
  });

  it('hides navigation until signed in', () => {
    const fixture = TestBed.createComponent(App);
    fixture.detectChanges();
    TestBed.inject(HttpTestingController).expectOne('/api/health').flush({ status: 'ok' });
    expect((fixture.nativeElement as HTMLElement).querySelector('nav')).toBeNull();
  });

  it('renders the toolbar with navigation, Immich status and sign-out', async () => {
    TestBed.inject(AuthStore).session.set({ mode: 'password', authenticated: true });
    const fixture = TestBed.createComponent(App);
    fixture.detectChanges();
    const http = TestBed.inject(HttpTestingController);
    http.expectOne('/api/health').flush({
      status: 'ok',
      database: { status: 'up' },
      immich: { status: 'up', version: 'v3.3.5' },
    });
    await fixture.whenStable();
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('mat-toolbar')?.textContent).toContain('Immich Album Jobs');
    expect([...el.querySelectorAll('nav a')].map((a) => a.textContent?.trim())).toEqual([
      'Jobs',
      'Settings',
    ]);
    expect(el.querySelector('[data-testid=immich-status]')?.textContent).toContain(
      'Immich connected',
    );
  });

  it('shows Immich problems from the health endpoint', async () => {
    TestBed.inject(AuthStore).session.set({ mode: 'forward-auth', authenticated: true });
    const fixture = TestBed.createComponent(App);
    fixture.detectChanges();
    TestBed.inject(HttpTestingController)
      .expectOne('/api/health')
      .flush({
        status: 'degraded',
        database: { status: 'up' },
        immich: { status: 'down', error: 'fetch failed' },
      });
    await fixture.whenStable();
    expect(
      (fixture.nativeElement as HTMLElement).querySelector('[data-testid=immich-status]')
        ?.textContent,
    ).toContain('Immich unreachable');
  });
});
