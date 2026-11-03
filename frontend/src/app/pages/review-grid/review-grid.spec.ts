import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import type { Candidate, CandidateSummary } from '../../core/models';
import { MatDialog } from '@angular/material/dialog';
import { of } from 'rxjs';
import type { ApplyResult } from '../../core/models';
import { applyConfirmation, applyMessage, columnsFor, ReviewGrid, toRows } from './review-grid';

const candidate = (i: number, over: Partial<Candidate> = {}): Candidate => ({
  assetId: `a${i}`,
  score: i % 3 === 0 ? 0.6 : 1,
  reasons: ['png'],
  originalFileName: `IMG_${i}.PNG`,
  selected: true,
  ...over,
});
const summary = (over: Partial<CandidateSummary> = {}): CandidateSummary => ({
  all: 1500,
  selected: 1500,
  unselected: 0,
  high: 1000,
  medium: 500,
  ...over,
});

describe('review grid helpers', () => {
  it('computes columns from the available width', () => {
    expect(columnsFor(100)).toBe(1);
    expect(columnsFor(1200)).toBe(6);
  });

  it('chunks items into rows', () => {
    expect(toRows([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(toRows([], 3)).toEqual([]);
  });
});

describe('apply confirmation', () => {
  const preview = {
    albumName: 'Screenshots',
    albumExists: false,
    exclusionAlbumName: 'Screenshots – excluded',
  };

  it('summarises what will be added', () => {
    expect(
      applyConfirmation({ ...preview, selected: 12, alreadyInAlbum: 2, excluded: 1, toAdd: 9 }),
    ).toEqual({
      title: 'Apply to album?',
      message:
        '9 assets will be added to "Screenshots" (new album).\n2 already in the album.\n1 skipped (in "Screenshots – excluded").\nNothing is removed.',
      confirm: 'Add 9',
    });
  });

  it('is information only when nothing would be added', () => {
    expect(
      applyConfirmation({
        ...preview,
        albumExists: true,
        selected: 3,
        alreadyInAlbum: 3,
        excluded: 0,
        toAdd: 0,
      }),
    ).toMatchObject({
      infoOnly: true,
    });
  });

  it('reports the result', () => {
    expect(applyMessage({ albumName: 'S', added: 1, failed: 2 } as ApplyResult)).toBe(
      'Added 1 asset to "S" (2 refused by Immich)',
    );
  });
});

describe('ReviewGrid', () => {
  let fixture: ComponentFixture<ReviewGrid>;
  let http: HttpTestingController;
  let dialogAnswer = true;

  const el = () => fixture.nativeElement as HTMLElement;
  /** Protected signals of the component under test. */
  interface Internals {
    items: () => Candidate[];
    rows: () => Candidate[][];
    summary: () => CandidateSummary;
    columns: { set(n: number): void };
    sort: { set(s: string): void };
  }
  const component = () => fixture.componentInstance as unknown as Internals;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [ReviewGrid],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: MatDialog, useValue: { open: () => ({ afterClosed: () => of(dialogAnswer) }) } },
      ],
    }).compileComponents();
    fixture = TestBed.createComponent(ReviewGrid);
    fixture.componentRef.setInput('runId', 'run-1');
    fixture.componentRef.setInput('albumName', 'Screenshots');
    http = TestBed.inject(HttpTestingController);
    fixture.detectChanges();
  });

  afterEach(() => http.verify());

  /** Answers the paged candidate requests (1,500 items → 2 pages). */
  function flushAll(total = 1500, s = summary()) {
    const first = http.expectOne(
      (r) => r.url === '/api/runs/run-1/candidates' && r.params.get('offset') === '0',
    );
    expect(first.request.params.get('limit')).toBe('1000');
    first.flush({
      items: Array.from({ length: Math.min(total, 1000) }, (_, i) => candidate(i)),
      total,
      summary: s,
    });
    if (total > 1000) {
      http
        .expectOne((r) => r.params.get('offset') === '1000')
        .flush({
          items: Array.from({ length: total - 1000 }, (_, i) => candidate(1000 + i)),
          total,
          summary: s,
        });
    }
  }

  it('loads all pages, sorted by score, and shows chip counts', async () => {
    flushAll();
    await fixture.whenStable();
    expect(component().items().length).toBe(1500);
    const chips = [...el().querySelectorAll('mat-chip-option')].map((c) => c.textContent?.trim());
    expect(chips).toEqual(['All (1500)', 'Score ≥ 0.8 (1000)', 'Below 0.8 (500)', 'Unticked (0)']);
  });

  it('builds rows for virtual scrolling from the column count', async () => {
    flushAll();
    component().columns.set(5);
    expect(component().rows().length).toBe(300);
  });

  it('reloads with the score band when a chip is chosen', () => {
    flushAll();
    fixture.componentInstance.setFilter('high');
    fixture.detectChanges();
    const req = http.expectOne((r) => r.url === '/api/runs/run-1/candidates');
    expect(req.request.params.get('minScore')).toBe('0.8');
    expect(req.request.params.get('sort')).toBe('-score');
    req.flush({ items: [], total: 0, summary: summary() });
  });

  it('reloads when the sort changes', () => {
    flushAll();
    component().sort.set('name');
    fixture.detectChanges();
    expect(
      http.expectOne((r) => r.url === '/api/runs/run-1/candidates').request.params.get('sort'),
    ).toBe('name');
  });

  it('unticks a candidate optimistically and stores it', () => {
    flushAll();
    const c = component().items()[0] as Candidate;
    fixture.componentInstance.toggle(c);
    expect((component().items()[0] as Candidate).selected).toBe(false);
    const req = http.expectOne({ method: 'PATCH', url: '/api/runs/run-1/candidates' });
    expect(req.request.body).toEqual({ selected: false, assetIds: ['a0'] });
    req.flush({ updated: 1, summary: summary({ selected: 1499, unselected: 1 }) });
    expect(component().summary().unselected).toBe(1);
  });

  it('reverts the checkbox if saving fails', () => {
    flushAll();
    fixture.componentInstance.toggle(component().items()[0]);
    http
      .expectOne({ method: 'PATCH', url: '/api/runs/run-1/candidates' })
      .flush({ message: 'x' }, { status: 409, statusText: 'Conflict' });
    expect((component().items()[0] as Candidate).selected).toBe(true);
  });

  it('bulk-unticks everything in the current filter', () => {
    flushAll();
    fixture.componentInstance.setFilter('medium');
    fixture.detectChanges();
    http
      .expectOne((r) => r.url === '/api/runs/run-1/candidates')
      .flush({ items: [candidate(3)], total: 1, summary: summary() });
    fixture.componentInstance.setAll(false);
    const req = http.expectOne({ method: 'PATCH', url: '/api/runs/run-1/candidates' });
    expect(req.request.body).toEqual({ selected: false, filter: { maxScore: 0.8 } });
    req.flush({ updated: 1, summary: summary() });
    expect((component().items()[0] as Candidate).selected).toBe(false);
  });

  it('applies after confirmation and emits the result', () => {
    flushAll();
    dialogAnswer = true;
    const emitted: ApplyResult[] = [];
    fixture.componentInstance.applied.subscribe((r) => emitted.push(r));
    fixture.componentInstance.apply();
    http.expectOne('/api/runs/run-1/apply-preview').flush({
      albumName: 'Screenshots',
      albumExists: true,
      exclusionAlbumName: 'x',
      selected: 1500,
      alreadyInAlbum: 0,
      excluded: 0,
      toAdd: 1500,
    });
    const req = http.expectOne({ method: 'POST', url: '/api/runs/run-1/apply' });
    req.flush({ albumName: 'Screenshots', added: 1500, failed: 0 });
    expect(emitted).toHaveLength(1);
  });

  it('does not apply when the dialog is cancelled', () => {
    flushAll();
    dialogAnswer = false;
    fixture.componentInstance.apply();
    http.expectOne('/api/runs/run-1/apply-preview').flush({
      albumName: 'S',
      albumExists: true,
      exclusionAlbumName: 'x',
      selected: 1,
      alreadyInAlbum: 0,
      excluded: 0,
      toAdd: 1,
    });
    http.expectNone({ method: 'POST', url: '/api/runs/run-1/apply' });
  });
});
