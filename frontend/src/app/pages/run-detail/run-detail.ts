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
  viewChild,
} from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { RouterLink } from '@angular/router';
import { forkJoin, type Subscription } from 'rxjs';
import { Api } from '../../core/api';
import { isActive, TERMINAL_STATUSES, type Job, type Run, type RunLog } from '../../core/models';
import { runEvents } from '../../core/run-events';
import { duration, parseServerDate } from '../../shared/format';
import { StatusChip } from '../../shared/status-chip';
import { ReviewGrid } from '../review-grid/review-grid';

/** Factory for EventSource; replaceable in tests. */
export const eventSourceFactory = { create: (url: string) => new EventSource(url) };

@Component({
  selector: 'app-run-detail',
  imports: [
    RouterLink,
    MatButtonModule,
    MatCardModule,
    MatIconModule,
    MatProgressBarModule,
    StatusChip,
    ReviewGrid,
  ],
  templateUrl: './run-detail.html',
  styleUrl: './run-detail.scss',
})
export class RunDetail {
  private readonly api = inject(Api);
  private readonly logBox = viewChild<ElementRef<HTMLElement>>('logBox');

  /** Route param. */
  readonly id = input.required<string>();

  protected readonly run = signal<Run | null>(null);
  protected readonly job = signal<Job | null>(null);
  protected readonly logs = signal<RunLog[]>([]);
  protected readonly acting = signal(false);
  protected readonly now = signal(Date.now());
  protected readonly active = computed(() => !!this.run() && isActive(this.run()!.status));
  protected readonly elapsed = computed(() => {
    const r = this.run();
    return r ? duration(r.startedAt, r.finishedAt, this.now()) : '';
  });
  protected readonly startedAt = computed(() => {
    const r = this.run();
    return r?.startedAt ? parseServerDate(r.startedAt).toLocaleString() : '';
  });
  protected readonly appliedAt = computed(() => {
    const r = this.run();
    return r?.appliedAt ? parseServerDate(r.appliedAt).toLocaleString() : '';
  });
  private events?: Subscription;
  private ticker?: ReturnType<typeof setInterval>;

  constructor() {
    effect(() => {
      const id = this.id();
      untracked(() => this.load(id));
    });
    effect(() => {
      this.logs();
      const box = this.logBox()?.nativeElement;
      if (box) queueMicrotask(() => (box.scrollTop = box.scrollHeight));
    });
    inject(DestroyRef).onDestroy(() => this.stopLive());
  }

  private load(id: string): void {
    this.stopLive();
    forkJoin({ run: this.api.run(id), logs: this.api.logs(id) }).subscribe(({ run, logs }) => {
      this.run.set(run);
      this.logs.set(logs);
      this.api
        .job(run.jobId)
        .subscribe({ next: (job) => this.job.set(job), error: () => this.job.set(null) });
      if (isActive(run.status)) this.startLive(id);
    });
  }

  private startLive(id: string): void {
    this.ticker = setInterval(() => this.now.set(Date.now()), 1000);
    let seq = -1;
    this.events = runEvents(id, eventSourceFactory.create).subscribe({
      next: (e) => {
        if (e.type === 'progress') {
          this.run.update((r) => (r ? { ...r, ...e.data } : r));
        } else if (e.type === 'status') {
          this.run.update((r) => (r ? { ...r, ...e.data } : r));
          if (TERMINAL_STATUSES.includes(e.data.status)) this.refresh(id);
        } else {
          const line: RunLog = { id: seq--, ...e.data };
          this.logs.update((list) =>
            list.some((l) => l.ts === line.ts && l.message === line.message)
              ? list
              : [...list, line],
          );
        }
      },
      complete: () => this.stopLive(),
    });
  }

  private stopLive(): void {
    this.events?.unsubscribe();
    this.events = undefined;
    clearInterval(this.ticker);
  }

  /** Reloads the authoritative run and log after the run ended. */
  private refresh(id: string): void {
    forkJoin({ run: this.api.run(id), logs: this.api.logs(id) }).subscribe(({ run, logs }) => {
      this.run.set(run);
      this.logs.set(logs);
    });
  }

  /** After "Apply to album": reload totals and log. */
  onApplied(): void {
    const r = this.run();
    if (r) this.refresh(r.id);
  }

  cancel(): void {
    const r = this.run();
    if (!r) return;
    this.acting.set(true);
    this.api.cancelRun(r.id).subscribe({
      next: (run) => {
        this.acting.set(false);
        this.run.set(run);
        if (!isActive(run.status)) this.refresh(run.id);
      },
      error: () => this.acting.set(false),
    });
  }

  resume(): void {
    const r = this.run();
    if (!r) return;
    this.acting.set(true);
    this.api.resumeRun(r.id).subscribe({
      next: (run) => {
        this.acting.set(false);
        this.run.set(run);
        this.startLive(run.id);
      },
      error: () => this.acting.set(false),
    });
  }

  time(ts: string): string {
    return parseServerDate(ts).toLocaleTimeString();
  }
}
