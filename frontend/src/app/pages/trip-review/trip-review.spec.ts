import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { MatDialog } from '@angular/material/dialog';
import { of } from 'rxjs';
import type { RunGroup, RunGroupsResponse } from '../../core/models';
import { formatLocalRange } from '../../shared/format';
import { actionSummary, badge, groupApplyConfirmation, TripReview, tripRange } from './trip-review';

const group = (over: Partial<RunGroup> = {}): RunGroup => ({
  key: 'trip:2026-03-04',
  action: 'create',
  jobGroupId: null,
  albumId: null,
  name: 'Thailand – Mar 2026',
  start: '2026-03-03T07:10:00.001Z',
  end: '2026-03-20T08:29:59.999Z',
  coreStart: '2026-03-04T00:20:00.000Z',
  coreEnd: '2026-03-19T15:30:00.000Z',
  ongoing: false,
  summary: {
    countries: ['Thailand'],
    cities: ['Bangkok', 'Chiang Mai'],
    days: 18,
    localStart: '2026-03-03T08:10:00.001',
    localEnd: '2026-03-20T09:29:59.999',
  },
  assetCount: 120,
  selected: true,
  ...over,
});

const summary = (over: Partial<RunGroupsResponse['summary']> = {}) => ({
  create: 1,
  update: 0,
  ignored: 0,
  locked: 0,
  orphaned: 0,
  merged: 0,
  selected: 1,
  ...over,
});

describe('trip review helpers', () => {
  it('labels proposed trips by action', () => {
    expect(badge({ action: 'create', albumId: null })).toEqual({ label: 'New', kind: 'new' });
    expect(badge({ action: 'create', albumId: 'x' }).label).toBe('Adopt album');
    expect(badge({ action: 'update', albumId: 'x' }).label).toBe('Existing');
    expect(badge({ action: 'orphaned', albumId: 'x' }).kind).toBe('warn');
  });

  it('formats local ranges without shifting days by the browser zone', () => {
    expect(tripRange(group())).toBe(
      formatLocalRange('2026-03-03T08:10:00.001', '2026-03-20T09:29:59.999'),
    );
    expect(formatLocalRange('2026-03-03', '2026-03-03', 'en-GB')).toBe('3 Mar 2026');
    // Spacing around the dash depends on the ICU version.
    expect(formatLocalRange('2026-03-03T23:00', '2026-03-20T01:00', 'en-GB')).toMatch(
      /^3\s*–\s*20 Mar 2026$/,
    );
  });

  it('summarises actions', () => {
    expect(actionSummary(summary({ create: 4, update: 17, orphaned: 1 }))).toBe(
      '4 new · 17 existing · 1 no longer detected',
    );
  });

  it('builds the apply confirmation', () => {
    expect(
      groupApplyConfirmation({
        kind: 'groups',
        selected: 3,
        create: 1,
        adopt: 1,
        update: 1,
        ignore: 2,
        assets: 400,
      }),
    ).toEqual({
      title: 'Apply trips?',
      message:
        '1 new album will be created.\n1 existing album will be used for a trip.\n1 album of earlier trips will be updated.\n2 unticked trips will be ignored by later runs.\n400 photos in the ticked trips. Nothing is removed.',
      confirm: 'Apply 3 trips',
    });
    expect(
      groupApplyConfirmation({
        kind: 'groups',
        selected: 0,
        create: 0,
        adopt: 0,
        update: 0,
        ignore: 0,
        assets: 0,
      }),
    ).toMatchObject({ infoOnly: true });
  });
});

describe('TripReview', () => {
  let fixture: ComponentFixture<TripReview>;
  let http: HttpTestingController;
  const el = () => fixture.nativeElement as HTMLElement;
  const groups = [
    group(),
    group({
      key: 'trip:2026-05-01',
      name: 'Czechia – May 2026',
      action: 'create',
      albumId: 'album-cz',
      summary: { ...group().summary, adoptAlbumId: 'album-cz', adoptAlbumName: 'Prague 2026' },
    }),
    group({ key: 'group:old', name: 'Denmark – Jul 2023', action: 'orphaned', selected: false }),
  ];

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [TripReview],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: MatDialog, useValue: { open: () => ({ afterClosed: () => of(true) }) } },
      ],
    }).compileComponents();
    fixture = TestBed.createComponent(TripReview);
    fixture.componentRef.setInput('runId', 'run-1');
    http = TestBed.inject(HttpTestingController);
    fixture.detectChanges();
    http
      .expectOne('/api/runs/run-1/groups')
      .flush({ items: groups, summary: summary({ create: 2, orphaned: 1, selected: 2 }) });
    for (const key of ['trip:2026-03-04', 'trip:2026-05-01'])
      http
        .expectOne((r) => r.url === '/api/runs/run-1/candidates' && r.params.get('group') === key)
        .flush({ items: [], total: 0, summary: {} });
    fixture.detectChanges();
    await fixture.whenStable();
  });

  afterEach(() => http.verify());

  it('shows one card per trip with badge, places and adoption switch', () => {
    const cards = [...el().querySelectorAll('[data-testid="trip"]')];
    expect(cards.map((c) => c.querySelector('[data-testid="trip-name"]')?.textContent)).toEqual([
      'Thailand – Mar 2026',
      'Czechia – May 2026',
      'Denmark – Jul 2023',
    ]);
    expect(cards.map((c) => c.querySelector('[data-testid="trip-badge"]')?.textContent)).toEqual([
      'New',
      'Adopt album',
      'No longer detected',
    ]);
    expect(cards[0].textContent).toContain('Bangkok, Chiang Mai');
    expect(cards[1].querySelector('[data-testid="trip-adopt"]')?.textContent).toContain(
      'Prague 2026',
    );
    // Orphaned trips cannot be ticked.
    expect(cards[2].querySelector('[data-testid="trip-check"]')).toBeNull();
    expect(el().querySelector('[data-testid="trip-summary"]')?.textContent).toBe(
      '2 new · 1 no longer detected',
    );
  });

  it('unticks a trip', () => {
    (el().querySelector('[data-testid="trip-check"]') as HTMLInputElement).click();
    const req = http.expectOne('/api/runs/run-1/groups');
    expect(req.request.method).toBe('PATCH');
    expect(req.request.body).toEqual({ selected: false, keys: ['trip:2026-03-04'] });
    req.flush({
      items: [{ ...groups[0], selected: false }, groups[1], groups[2]],
      summary: summary({ selected: 1 }),
      updated: 1,
    });
  });

  it('applies after confirmation and reloads', () => {
    const emitted: unknown[] = [];
    fixture.componentInstance.applied.subscribe((r) => emitted.push(r));
    (el().querySelector('[data-testid="apply-trips"]') as HTMLButtonElement).click();
    http.expectOne('/api/runs/run-1/apply-preview').flush({
      kind: 'groups',
      selected: 2,
      create: 1,
      adopt: 1,
      update: 0,
      ignore: 0,
      assets: 240,
    });
    const apply = http.expectOne('/api/runs/run-1/apply');
    expect(apply.request.method).toBe('POST');
    apply.flush({ kind: 'groups', result: {}, summary: 'Album sync: 1 albums created' });
    expect(emitted).toHaveLength(1);
    http.expectOne('/api/runs/run-1/groups').flush({ items: groups, summary: summary() });
    http.match(() => true).forEach((r) => r.flush({ items: [], total: 0, summary: {} }));
  });
});
