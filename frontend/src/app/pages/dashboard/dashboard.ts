import { Component, computed, inject, signal, type OnInit } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatTableModule } from '@angular/material/table';
import { MatTooltipModule } from '@angular/material/tooltip';
import { Router, RouterLink } from '@angular/router';
import { forkJoin } from 'rxjs';
import { Api } from '../../core/api';
import { HealthStore } from '../../core/health.store';
import { isActive, type Job, type JobType } from '../../core/models';
import { relativeTime } from '../../shared/format';
import { StatusChip } from '../../shared/status-chip';

const SYNC_LABELS: Record<string, string> = {
  'dry-run': 'Dry run only',
  additive: 'Additive',
  mirror: 'Mirror',
};

@Component({
  selector: 'app-dashboard',
  imports: [
    RouterLink,
    MatTableModule,
    MatButtonModule,
    MatIconModule,
    MatCardModule,
    MatTooltipModule,
    MatProgressBarModule,
    StatusChip,
  ],
  templateUrl: './dashboard.html',
  styleUrl: './dashboard.scss',
})
export class Dashboard implements OnInit {
  private readonly api = inject(Api);
  private readonly router = inject(Router);
  protected readonly healthStore = inject(HealthStore);

  protected readonly jobs = signal<Job[]>([]);
  protected readonly types = signal<Map<string, JobType>>(new Map());
  protected readonly loading = signal(true);
  protected readonly starting = signal<string | null>(null);
  protected readonly columns = ['name', 'type', 'sync', 'schedule', 'lastRun', 'actions'];
  protected readonly syncLabels = SYNC_LABELS;
  protected readonly relativeTime = relativeTime;
  protected readonly isActive = isActive;

  protected readonly immich = computed(() => this.healthStore.health()?.immich);

  ngOnInit(): void {
    this.load();
  }

  load(): void {
    this.loading.set(true);
    forkJoin({ jobs: this.api.jobs(), types: this.api.jobTypes() }).subscribe({
      next: ({ jobs, types }) => {
        this.jobs.set(jobs);
        this.types.set(new Map(types.map((t) => [t.id, t])));
        this.loading.set(false);
      },
      error: () => this.loading.set(false),
    });
  }

  typeName(job: Job): string {
    return this.types().get(job.typeId)?.name ?? job.typeId;
  }

  start(job: Job, dryRun: boolean): void {
    this.starting.set(job.id);
    this.api.startRun(job.id, { dryRun }).subscribe({
      next: (run) => void this.router.navigate(['/runs', run.id]),
      error: () => {
        this.starting.set(null);
        this.load(); // e.g. 409: someone else started a run
      },
    });
  }
}
