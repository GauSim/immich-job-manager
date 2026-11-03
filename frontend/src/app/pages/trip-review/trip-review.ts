import {
  Component,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  untracked,
} from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatDialog } from '@angular/material/dialog';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import { MatSnackBar } from '@angular/material/snack-bar';
import { MatTooltipModule } from '@angular/material/tooltip';
import { finalize, of, switchMap } from 'rxjs';
import { Api } from '../../core/api';
import type {
  GroupAction,
  GroupApplyPreview,
  GroupApplyResult,
  RunGroup,
  RunGroupsResponse,
} from '../../core/models';
import { confirm } from '../../shared/confirm-dialog';
import { formatLocalRange, localDays } from '../../shared/format';
import { TripAssets } from './trip-assets';

/** Badge per proposed trip. */
export function badge(g: Pick<RunGroup, 'action' | 'albumId'>): { label: string; kind: string } {
  switch (g.action) {
    case 'create':
      return g.albumId ? { label: 'Adopt album', kind: 'adopt' } : { label: 'New', kind: 'new' };
    case 'update':
      return { label: 'Existing', kind: 'update' };
    case 'ignored':
      return { label: 'Ignored', kind: 'muted' };
    case 'locked':
      return { label: 'Locked', kind: 'muted' };
    case 'orphaned':
      return { label: 'No longer detected', kind: 'warn' };
    case 'merged':
      return { label: 'Merged', kind: 'warn' };
  }
}

/** Range shown for a proposed trip: local travel range if known, else the core range. */
export function tripRange(g: RunGroup): string {
  return formatLocalRange(g.summary.localStart ?? g.coreStart, g.summary.localEnd ?? g.coreEnd);
}

export function tripDays(g: RunGroup): number {
  return g.summary.days ?? localDays(g.summary.localStart ?? g.start, g.summary.localEnd ?? g.end);
}

const n = (v: number) => v.toLocaleString();
const plural = (v: number, word: string) => `${n(v)} ${word}${v === 1 ? '' : 's'}`;

export function groupApplyConfirmation(p: GroupApplyPreview) {
  const lines: string[] = [];
  if (p.create) lines.push(`${plural(p.create, 'new album')} will be created.`);
  if (p.adopt) lines.push(`${plural(p.adopt, 'existing album')} will be used for a trip.`);
  if (p.update) lines.push(`${plural(p.update, 'album')} of earlier trips will be updated.`);
  if (p.ignore) lines.push(`${plural(p.ignore, 'unticked trip')} will be ignored by later runs.`);
  lines.push(`${plural(p.assets, 'photo')} in the ticked trips. Nothing is removed.`);
  return p.selected || p.ignore
    ? {
        title: 'Apply trips?',
        message: lines.join('\n'),
        confirm: p.selected ? `Apply ${plural(p.selected, 'trip')}` : 'Apply',
      }
    : { title: 'Apply trips', message: 'Nothing to apply.', infoOnly: true };
}

/** Summary line, e.g. `4 new · 17 existing · 1 no longer detected`. */
export function actionSummary(s: RunGroupsResponse['summary']): string {
  const parts: [GroupAction, string][] = [
    ['create', 'new'],
    ['update', 'existing'],
    ['ignored', 'ignored'],
    ['locked', 'locked'],
    ['orphaned', 'no longer detected'],
    ['merged', 'merged'],
  ];
  return parts
    .filter(([a]) => s[a])
    .map(([a, label]) => `${n(s[a])} ${label}`)
    .join(' · ');
}

const SELECTABLE: GroupAction[] = ['create', 'update'];

/**
 * Dry-run review of a group job (trip-albums SDD §9.1): one card per proposed
 * trip with dates, places, photo counts, covers and the action; tick/untick,
 * adopt ↔ new album, expand to see the photos, apply.
 */
@Component({
  selector: 'app-trip-review',
  imports: [
    MatButtonModule,
    MatIconModule,
    MatProgressBarModule,
    MatSlideToggleModule,
    MatTooltipModule,
    TripAssets,
  ],
  templateUrl: './trip-review.html',
  styleUrl: './trip-review.scss',
})
export class TripReview {
  private readonly api = inject(Api);
  private readonly dialog = inject(MatDialog);
  private readonly snackBar = inject(MatSnackBar);

  readonly runId = input.required<string>();
  /** The dry run was already applied (it can be applied once). */
  readonly appliedAt = input<string | null>(null);
  readonly applied = output<GroupApplyResult>();

  protected readonly groups = signal<RunGroup[]>([]);
  protected readonly summary = signal<RunGroupsResponse['summary'] | null>(null);
  protected readonly loading = signal(false);
  protected readonly applying = signal(false);
  protected readonly expanded = signal<string | null>(null);
  /** First assets per trip key, for the cover thumbnails. */
  protected readonly covers = signal<Record<string, string[]>>({});
  protected readonly summaryText = computed(() => {
    const s = this.summary();
    return s ? actionSummary(s) : '';
  });

  constructor() {
    effect(() => {
      const runId = this.runId();
      untracked(() => this.load(runId));
    });
  }

  load(runId = this.runId()): void {
    this.loading.set(true);
    this.api.runGroups(runId).subscribe({
      next: (res) => {
        this.groups.set(res.items);
        this.summary.set(res.summary);
        this.loading.set(false);
        this.loadCovers(runId, res.items);
      },
      error: () => this.loading.set(false),
    });
  }

  private loadCovers(runId: string, groups: RunGroup[]): void {
    for (const g of groups.filter((x) => this.selectable(x))) {
      this.api
        .candidates(runId, { group: g.key, limit: 4, sort: 'name' })
        .subscribe((page) =>
          this.covers.update((c) => ({ ...c, [g.key]: page.items.map((i) => i.assetId) })),
        );
    }
  }

  protected selectable(g: RunGroup): boolean {
    return SELECTABLE.includes(g.action);
  }

  toggle(g: RunGroup): void {
    this.update({ selected: !g.selected, keys: [g.key] });
  }

  setAll(selected: boolean): void {
    this.update({ selected });
  }

  /** `create` with a proposed existing album: adopt it, or make a new album. */
  setAdopt(g: RunGroup, adopt: boolean): void {
    this.update({ adopt, keys: [g.key] });
  }

  private update(body: { selected?: boolean; adopt?: boolean; keys?: string[] }): void {
    this.api.updateRunGroups(this.runId(), body).subscribe((res) => {
      this.groups.set(res.items);
      this.summary.set(res.summary);
    });
  }

  toggleExpanded(g: RunGroup): void {
    this.expanded.update((k) => (k === g.key ? null : g.key));
  }

  apply(): void {
    this.applying.set(true);
    this.api
      .groupApplyPreview(this.runId())
      .pipe(
        switchMap((p) =>
          confirm(this.dialog, groupApplyConfirmation(p)).pipe(
            switchMap((ok) =>
              ok && (p.selected || p.ignore) ? this.api.groupApply(this.runId()) : of(null),
            ),
          ),
        ),
        finalize(() => this.applying.set(false)),
      )
      .subscribe((result) => {
        if (!result) return;
        this.snackBar.open(result.summary, undefined, { duration: 6000 });
        this.applied.emit(result);
        this.load();
      });
  }

  thumbnail(assetId: string): string {
    return this.api.thumbnailUrl(assetId);
  }

  protected badge = badge;
  protected range = tripRange;
  protected days = tripDays;
}
