import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import type { Candidate, CandidateSummary } from '../../core/models';
import { columnsFor, ReviewGrid, toRows } from './review-grid';

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

describe('ReviewGrid', () => {
  let fixture: ComponentFixture<ReviewGrid>;
  let http: HttpTestingController;

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
      providers: [provideHttpClient(), provideHttpClientTesting()],
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
});
