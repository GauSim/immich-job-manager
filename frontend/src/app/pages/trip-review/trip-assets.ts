import { ScrollingModule } from '@angular/cdk/scrolling';
import {
  Component,
  computed,
  DestroyRef,
  effect,
  ElementRef,
  inject,
  input,
  signal,
  untracked,
} from '@angular/core';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { EMPTY, expand, reduce, type Subscription } from 'rxjs';
import { Api } from '../../core/api';
import type { Candidate } from '../../core/models';
import { columnsFor, toRows } from '../review-grid/review-grid';

const PAGE_SIZE = 1000;
const ROW_HEIGHT = 236;

/** Readable labels for trip reasons. */
export const REASON_LABELS: Record<string, string> = {
  'gps-away': 'away',
  'gps-in-range': 'during the trip',
  'transit-departure': 'travel day',
  'transit-return': 'travel day',
  'no-gps-camera': 'camera, no GPS',
  'no-gps': 'no GPS',
  partner: 'partner',
};

export const reasonLabel = (r: string) => REASON_LABELS[r] ?? r;

/**
 * Photos of one proposed trip (read-only): thumbnails with why each photo is
 * in the trip. Virtualised like the review grid.
 */
@Component({
  selector: 'app-trip-assets',
  imports: [ScrollingModule, MatProgressBarModule],
  template: `
    @if (loading()) {
      <mat-progress-bar mode="indeterminate" />
    }
    <cdk-virtual-scroll-viewport
      class="viewport"
      [itemSize]="rowHeight"
      minBufferPx="500"
      maxBufferPx="1000"
    >
      <div
        *cdkVirtualFor="let row of rows(); trackBy: trackRow"
        class="row"
        [style.height.px]="rowHeight"
      >
        @for (c of row; track c.assetId) {
          <div class="card" data-testid="trip-asset">
            <img
              [src]="thumbnail(c)"
              loading="lazy"
              decoding="async"
              [alt]="c.originalFileName ?? ''"
              class="thumb"
            />
            <div class="name" [title]="c.originalFileName ?? c.assetId">
              {{ c.originalFileName ?? c.assetId }}
            </div>
            <div class="reasons">
              @for (r of c.reasons; track r) {
                <span class="reason">{{ label(r) }}</span>
              }
            </div>
          </div>
        }
      </div>
    </cdk-virtual-scroll-viewport>
  `,
  styles: `
    .viewport {
      height: 480px;
    }
    .row {
      display: flex;
      gap: 12px;
    }
    .card {
      width: 172px;
      display: flex;
      flex-direction: column;
      gap: 4px;
    }
    .thumb {
      width: 172px;
      height: 160px;
      object-fit: cover;
      border-radius: 8px;
      background: var(--mat-sys-surface-container);
    }
    .name {
      font: var(--mat-sys-body-small);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .reasons {
      display: flex;
      flex-wrap: wrap;
      gap: 4px;
    }
    .reason {
      font: var(--mat-sys-label-small);
      padding: 0 6px;
      border-radius: 8px;
      background: var(--mat-sys-secondary-container);
      color: var(--mat-sys-on-secondary-container);
    }
  `,
})
export class TripAssets {
  private readonly api = inject(Api);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

  readonly runId = input.required<string>();
  readonly group = input.required<string>();

  protected readonly items = signal<Candidate[]>([]);
  protected readonly loading = signal(false);
  protected readonly columns = signal(4);
  protected readonly rows = computed(() => toRows(this.items(), this.columns()));
  protected readonly rowHeight = ROW_HEIGHT;
  protected readonly label = reasonLabel;
  private sub?: Subscription;

  constructor() {
    effect(() => {
      const [runId, group] = [this.runId(), this.group()];
      untracked(() => this.load(runId, group));
    });
    if (typeof ResizeObserver !== 'undefined') {
      const observer = new ResizeObserver(([entry]) =>
        this.columns.set(columnsFor(entry.contentRect.width)),
      );
      observer.observe(this.host.nativeElement);
      inject(DestroyRef).onDestroy(() => observer.disconnect());
    }
    inject(DestroyRef).onDestroy(() => this.sub?.unsubscribe());
  }

  private load(runId: string, group: string): void {
    this.sub?.unsubscribe();
    this.loading.set(true);
    const query = { group, sort: 'name' as const, limit: PAGE_SIZE };
    let offset = 0;
    this.sub = this.api
      .candidates(runId, { ...query, offset })
      .pipe(
        expand((page) => {
          offset += page.items.length;
          return page.items.length > 0 && offset < page.total
            ? this.api.candidates(runId, { ...query, offset })
            : EMPTY;
        }),
        reduce((acc, page) => acc.concat(page.items), [] as Candidate[]),
      )
      .subscribe({
        next: (items) => {
          this.items.set(items);
          this.loading.set(false);
        },
        error: () => this.loading.set(false),
      });
  }

  thumbnail(c: Candidate): string {
    return this.api.thumbnailUrl(c.assetId);
  }

  protected trackRow = (_: number, row: Candidate[]) => row[0]?.assetId;
}
