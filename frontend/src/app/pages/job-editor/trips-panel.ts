import { Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatIconModule } from '@angular/material/icon';
import { MatMenuModule } from '@angular/material/menu';
import { MatTooltipModule } from '@angular/material/tooltip';
import { catchError, forkJoin, of } from 'rxjs';
import { Api } from '../../core/api';
import type { GroupStatus, JobGroup, TripInsights } from '../../core/models';
import { formatLocalRange } from '../../shared/format';

export const GROUP_STATUS_LABELS: Record<GroupStatus, string> = {
  active: 'Active',
  ongoing: 'Ongoing',
  ignored: 'Ignored',
  orphaned: 'No longer detected',
  merged: 'Merged',
  locked: 'Locked',
};

/** Immich web URL of an album, from the API URL (`…/api`). */
export function albumUrl(immichApiUrl: string | undefined, albumId: string): string | null {
  if (!immichApiUrl) return null;
  return `${immichApiUrl.replace(/\/api\/?$/, '')}/albums/${albumId}`;
}

/** Date range of a stored group: the trip's local range, else its core range. */
export function groupRange(g: Pick<JobGroup, 'summary' | 'coreStart' | 'coreEnd'>): string {
  return formatLocalRange(g.summary.localStart ?? g.coreStart, g.summary.localEnd ?? g.coreEnd);
}

/**
 * Job page panel for group jobs (trip-albums SDD §9.2): the stored trips with
 * status, album link and actions (ignore / lock / activate), and the inferred
 * home per period.
 */
@Component({
  selector: 'app-trips-panel',
  imports: [MatButtonModule, MatCardModule, MatIconModule, MatMenuModule, MatTooltipModule],
  template: `
    <mat-card appearance="outlined" data-testid="trips-panel">
      <mat-card-header>
        <mat-card-title>Trips ({{ groups().length }})</mat-card-title>
      </mat-card-header>
      <mat-card-content>
        @for (g of groups(); track g.id) {
          <div class="trip" data-testid="trip-row" [class.inactive]="!isLive(g.status)">
            <div class="main">
              @if (g.albumId && link(g.albumId); as url) {
                <a [href]="url" target="_blank" rel="noopener" class="name">{{ g.name }}</a>
              } @else {
                <span class="name">{{ g.name }}</span>
              }
              <span class="muted small">
                {{ range(g) }} · {{ g.assetCount }} photos
                @if (g.excludedCount) {
                  · {{ g.excludedCount }} removed by you
                }
                @if (g.adopted) {
                  · existing album
                }
              </span>
            </div>
            <span class="status" [class]="'status ' + g.status" data-testid="trip-status">{{
              statusLabel(g.status)
            }}</span>
            <button
              matIconButton
              [matMenuTriggerFor]="menu"
              [attr.aria-label]="'Actions for ' + g.name"
              data-testid="trip-actions"
            >
              <mat-icon>more_vert</mat-icon>
            </button>
            <mat-menu #menu="matMenu">
              @if (g.status !== 'ignored') {
                <button mat-menu-item (click)="setStatus(g, 'ignored')">
                  <mat-icon>visibility_off</mat-icon>Ignore (never sync again)
                </button>
              }
              @if (g.status !== 'locked') {
                <button mat-menu-item (click)="setStatus(g, 'locked')">
                  <mat-icon>lock</mat-icon>Lock (keep the album as it is)
                </button>
              }
              @if (g.status === 'ignored' || g.status === 'locked') {
                <button mat-menu-item (click)="setStatus(g, 'active')">
                  <mat-icon>sync</mat-icon>Activate
                </button>
              }
            </mat-menu>
          </div>
        } @empty {
          <p class="muted">No trips yet. Run a dry run and apply it, or run the job.</p>
        }
      </mat-card-content>
    </mat-card>

    @if (home().length) {
      <mat-card appearance="outlined" data-testid="home-panel">
        <mat-card-header>
          <mat-card-title>Home</mat-card-title>
          <mat-card-subtitle>Inferred from your photos</mat-card-subtitle>
        </mat-card-header>
        <mat-card-content>
          @for (h of home(); track h.from) {
            <div class="home">
              <span class="muted">{{ h.from === h.to ? h.from : h.from + ' – ' + h.to }}</span>
              <span>{{ h.country ?? 'unknown' }}</span>
            </div>
          }
        </mat-card-content>
      </mat-card>
    }
  `,
  styles: `
    :host {
      display: flex;
      flex-direction: column;
      gap: 16px;
    }
    .trip {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 6px 0;
      border-bottom: 1px solid var(--mat-sys-outline-variant);
    }
    .trip.inactive .name {
      color: var(--mat-sys-on-surface-variant);
    }
    .main {
      display: flex;
      flex-direction: column;
      flex: 1;
      min-width: 0;
    }
    .name {
      font: var(--mat-sys-body-large);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .small {
      font: var(--mat-sys-body-small);
    }
    .status {
      font: var(--mat-sys-label-small);
      padding: 2px 8px;
      border-radius: 10px;
      background: var(--mat-sys-surface-container-high);
      white-space: nowrap;
    }
    .status.active,
    .status.ongoing {
      background: #d7f5dd;
      color: #0b5e1f;
    }
    .home {
      display: flex;
      justify-content: space-between;
      gap: 8px;
      padding: 2px 0;
    }
  `,
})
export class TripsPanel {
  private readonly api = inject(Api);
  readonly jobId = input.required<string>();

  protected readonly groups = signal<JobGroup[]>([]);
  protected readonly insights = signal<TripInsights | null>(null);
  protected readonly immichUrl = signal<string | undefined>(undefined);
  protected readonly home = computed(() => this.insights()?.home ?? []);

  constructor() {
    effect(() => {
      const id = this.jobId();
      untracked(() => this.load(id));
    });
  }

  load(id = this.jobId()): void {
    forkJoin({
      groups: this.api.jobGroups(id),
      // Insights need the index (first run) and `user.read`; the panel works without them.
      insights: this.api.tripInsights(id).pipe(catchError(() => of(null))),
      settings: this.api.settings().pipe(catchError(() => of(null))),
    }).subscribe(({ groups, insights, settings }) => {
      this.groups.set(groups);
      this.insights.set(insights);
      this.immichUrl.set(settings?.app.immichUrl);
    });
  }

  setStatus(g: JobGroup, status: 'active' | 'ignored' | 'locked'): void {
    this.api
      .updateJobGroup(this.jobId(), g.id, status)
      .subscribe((updated) =>
        this.groups.update((list) => list.map((x) => (x.id === updated.id ? updated : x))),
      );
  }

  protected link(albumId: string): string | null {
    return albumUrl(this.immichUrl(), albumId);
  }

  protected range = groupRange;
  protected statusLabel = (s: GroupStatus) => GROUP_STATUS_LABELS[s];
  protected isLive = (s: GroupStatus) => s === 'active' || s === 'ongoing';
}
