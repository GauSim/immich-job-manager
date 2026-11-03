import { ScrollingModule } from '@angular/cdk/scrolling';
import {
  Component,
  computed,
  DestroyRef,
  effect,
  ElementRef,
  inject,
  input,
  output,
  signal,
  untracked,
} from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatChipsModule } from '@angular/material/chips';
import { MatDialog } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatSelectModule } from '@angular/material/select';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatSnackBar } from '@angular/material/snack-bar';
import { EMPTY, expand, finalize, of, reduce, switchMap, type Subscription } from 'rxjs';
import { Api } from '../../core/api';
import type {
  ApplyPreview,
  ApplyResult,
  Candidate,
  CandidateFilter,
  CandidateSort,
  CandidateSummary,
} from '../../core/models';
import { confirm } from '../../shared/confirm-dialog';

export type FilterKey = 'all' | 'high' | 'medium' | 'unticked';

export const HIGH_SCORE = 0.8;
export const FILTERS: Record<FilterKey, CandidateFilter> = {
  all: {},
  high: { minScore: HIGH_SCORE },
  medium: { maxScore: HIGH_SCORE },
  unticked: { selected: false },
};

/** Card width/height incl. gap; the grid is virtualised by rows of cards. */
export const CARD_WIDTH = 184;
export const ROW_HEIGHT = 268;
const GAP = 12;
const PAGE_SIZE = 1000;

export function columnsFor(width: number): number {
  return Math.max(1, Math.floor((width + GAP) / (CARD_WIDTH + GAP)));
}

export function toRows<T>(items: T[], columns: number): T[][] {
  const rows: T[][] = [];
  for (let i = 0; i < items.length; i += columns) rows.push(items.slice(i, i + columns));
  return rows;
}

/**
 * Dry-run review grid (SDD §9.2): thumbnail cards with score and reasons,
 * score-band chips, sort, tick/untick. Virtual scroll keeps the DOM small
 * for thousands of candidates; thumbnails load only for rendered rows.
 */
@Component({
  selector: 'app-review-grid',
  imports: [
    ScrollingModule,
    MatButtonModule,
    MatChipsModule,
    MatFormFieldModule,
    MatIconModule,
    MatProgressBarModule,
    MatSelectModule,
    MatTooltipModule,
  ],
  templateUrl: './review-grid.html',
  styleUrl: './review-grid.scss',
})
export class ReviewGrid {
  private readonly api = inject(Api);
  private readonly dialog = inject(MatDialog);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

  readonly runId = input.required<string>();
  readonly albumName = input<string>('');
  /** Emitted after the selection was applied to the album. */
  readonly applied = output<ApplyResult>();
  protected readonly applying = signal(false);
  private readonly snackBar = inject(MatSnackBar);

  protected readonly items = signal<Candidate[]>([]);
  protected readonly total = signal(0);
  protected readonly summary = signal<CandidateSummary | null>(null);
  protected readonly loading = signal(false);
  protected readonly filter = signal<FilterKey>('all');
  protected readonly sort = signal<CandidateSort>('-score');
  protected readonly columns = signal(4);
  protected readonly rows = computed(() => toRows(this.items(), this.columns()));
  protected readonly rowHeight = ROW_HEIGHT;
  protected readonly highScore = HIGH_SCORE;
  private loadSub?: Subscription;

  constructor() {
    effect(() => {
      const [runId, filter, sort] = [this.runId(), this.filter(), this.sort()];
      untracked(() => this.load(runId, filter, sort));
    });
    if (typeof ResizeObserver !== 'undefined') {
      const observer = new ResizeObserver(([entry]) =>
        this.columns.set(columnsFor(entry.contentRect.width)),
      );
      observer.observe(this.host.nativeElement);
      inject(DestroyRef).onDestroy(() => observer.disconnect());
    }
    inject(DestroyRef).onDestroy(() => this.loadSub?.unsubscribe());
  }

  /** Loads all candidates for the current filter, page by page (a few thousand are fine in memory). */
  load(runId = this.runId(), filter = this.filter(), sort = this.sort()): void {
    this.loadSub?.unsubscribe();
    this.loading.set(true);
    const query = { ...FILTERS[filter], sort, limit: PAGE_SIZE };
    let offset = 0;
    this.loadSub = this.api
      .candidates(runId, { ...query, offset })
      .pipe(
        expand((page) => {
          offset += page.items.length;
          return page.items.length > 0 && offset < page.total
            ? this.api.candidates(runId, { ...query, offset })
            : EMPTY;
        }),
        reduce(
          (acc, page) => ({
            items: acc.items.concat(page.items),
            total: page.total,
            summary: page.summary,
          }),
          { items: [] as Candidate[], total: 0, summary: null as CandidateSummary | null },
        ),
      )
      .subscribe({
        next: ({ items, total, summary }) => {
          this.items.set(items);
          this.total.set(total);
          this.summary.set(summary);
          this.loading.set(false);
        },
        error: () => this.loading.set(false),
      });
  }

  setFilter(key: FilterKey | undefined): void {
    if (key) this.filter.set(key);
  }

  toggle(c: Candidate): void {
    const selected = !c.selected;
    this.setSelected([c.assetId], selected);
    this.api.updateCandidates(this.runId(), { selected, assetIds: [c.assetId] }).subscribe({
      next: ({ summary }) => this.summary.set(summary),
      error: () => this.setSelected([c.assetId], !selected),
    });
  }

  /** Ticks/unticks everything matching the current filter. */
  setAll(selected: boolean): void {
    const filter = FILTERS[this.filter()];
    this.api
      .updateCandidates(
        this.runId(),
        Object.keys(filter).length ? { selected, filter } : { selected },
      )
      .subscribe(({ summary }) => {
        this.summary.set(summary);
        this.items.update((list) => list.map((c) => ({ ...c, selected })));
      });
  }

  /** Preview counts → confirmation → add the selected candidates to the album. */
  apply(): void {
    this.applying.set(true);
    this.api
      .applyPreview(this.runId())
      .pipe(
        switchMap((p) =>
          confirm(this.dialog, applyConfirmation(p)).pipe(
            switchMap((ok) => (ok && p.toAdd > 0 ? this.api.apply(this.runId()) : of(null))),
          ),
        ),
        finalize(() => this.applying.set(false)),
      )
      .subscribe((result) => {
        if (!result) return;
        this.snackBar.open(applyMessage(result), undefined, { duration: 5000 });
        this.applied.emit(result);
      });
  }

  thumbnail(c: Candidate): string {
    return this.api.thumbnailUrl(c.assetId);
  }

  protected trackRow = (_: number, row: Candidate[]) => row[0]?.assetId;

  private setSelected(ids: string[], selected: boolean): void {
    const set = new Set(ids);
    this.items.update((list) => list.map((c) => (set.has(c.assetId) ? { ...c, selected } : c)));
  }
}

const n = (v: number) => v.toLocaleString();

export function applyConfirmation(p: ApplyPreview) {
  const lines = [
    p.toAdd > 0
      ? `${n(p.toAdd)} asset${p.toAdd === 1 ? '' : 's'} will be added to "${p.albumName}"${p.albumExists ? '' : ' (new album)'}.`
      : `Nothing to add: all selected assets are already in "${p.albumName}" or excluded.`,
  ];
  if (p.alreadyInAlbum) lines.push(`${n(p.alreadyInAlbum)} already in the album.`);
  if (p.excluded) lines.push(`${n(p.excluded)} skipped (in "${p.exclusionAlbumName}").`);
  lines.push('Nothing is removed.');
  return p.toAdd > 0
    ? { title: 'Apply to album?', message: lines.join('\n'), confirm: `Add ${n(p.toAdd)}` }
    : { title: 'Apply to album', message: lines.join('\n'), infoOnly: true };
}

export function applyMessage(r: ApplyResult): string {
  const failed = r.failed ? ` (${n(r.failed)} refused by Immich)` : '';
  return `Added ${n(r.added)} asset${r.added === 1 ? '' : 's'} to "${r.albumName}"${failed}`;
}
