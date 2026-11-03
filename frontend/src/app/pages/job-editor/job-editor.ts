import { Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { FormControl, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatDialog } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatSelectModule } from '@angular/material/select';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import { MatSnackBar } from '@angular/material/snack-bar';
import { MatTooltipModule } from '@angular/material/tooltip';
import { Router, RouterLink } from '@angular/router';
import { forkJoin, of } from 'rxjs';
import { Api } from '../../core/api';
import { isValidationError } from '../../core/error.interceptor';
import { applyServerErrors } from '../../core/form-errors';
import {
  isActive,
  type FieldError,
  type Job,
  type JobInput,
  type JobType,
  type Run,
  type SyncMode,
} from '../../core/models';
import { confirm } from '../../shared/confirm-dialog';
import { parseServerDate, relativeTime } from '../../shared/format';
import { ParamsForm } from '../../shared/params-form';
import { StatusChip } from '../../shared/status-chip';

const clone = <T>(v: T): T => structuredClone(v);

@Component({
  selector: 'app-job-editor',
  imports: [
    ReactiveFormsModule,
    RouterLink,
    MatButtonModule,
    MatCardModule,
    MatFormFieldModule,
    MatIconModule,
    MatInputModule,
    MatProgressBarModule,
    MatSelectModule,
    MatSlideToggleModule,
    MatTooltipModule,
    ParamsForm,
    StatusChip,
  ],
  templateUrl: './job-editor.html',
  styleUrl: './job-editor.scss',
})
export class JobEditor {
  private readonly api = inject(Api);
  private readonly router = inject(Router);
  private readonly dialog = inject(MatDialog);
  private readonly snackBar = inject(MatSnackBar);

  /** Route param (`/jobs/:id`); undefined on `/jobs/new`. */
  readonly id = input<string>();

  protected readonly types = signal<JobType[]>([]);
  protected readonly job = signal<Job | null>(null);
  protected readonly runs = signal<Run[]>([]);
  protected readonly loading = signal(true);
  protected readonly saving = signal(false);
  protected readonly starting = signal(false);
  protected readonly formErrors = signal<FieldError[]>([]);
  /** Formly mutates this object; replaced when the type changes. */
  protected readonly paramsModel = signal<Record<string, unknown>>({});
  protected readonly relativeTime = relativeTime;
  protected readonly localTime = (iso: string) => parseServerDate(iso).toLocaleString();

  protected readonly form = new FormGroup({
    name: new FormControl('', {
      nonNullable: true,
      validators: [Validators.required, Validators.maxLength(200)],
    }),
    typeId: new FormControl('', { nonNullable: true, validators: Validators.required }),
    targetAlbumName: new FormControl('', {
      nonNullable: true,
      validators: [Validators.required, Validators.maxLength(200)],
    }),
    exclusionAlbumName: new FormControl('', { nonNullable: true }),
    syncMode: new FormControl<SyncMode>('dry-run', { nonNullable: true }),
    schedule: new FormControl('', { nonNullable: true }),
    enabled: new FormControl(false, { nonNullable: true }),
    params: new FormGroup({}),
  });

  protected readonly isNew = computed(() => !this.id());
  private readonly typeId = signal('');
  protected readonly type = computed(
    () => this.types().find((t) => t.id === this.typeId()) ?? null,
  );
  protected readonly busy = computed(() => this.runs().some((r) => isActive(r.status)));

  constructor() {
    this.form.controls.typeId.valueChanges.subscribe((typeId) => {
      this.typeId.set(typeId);
      if (this.isNew())
        this.resetParams(this.types().find((t) => t.id === typeId)?.defaultParams ?? {});
    });
    this.form.controls.targetAlbumName.valueChanges.subscribe(() =>
      this.exclusionPlaceholder.set(this.defaultExclusion()),
    );
    effect(() => {
      const id = this.id();
      untracked(() => this.load(id));
    });
  }

  protected readonly exclusionPlaceholder = signal('');
  private defaultExclusion(): string {
    const target = this.form.controls.targetAlbumName.value.trim();
    return target ? `${target} – excluded` : '';
  }

  private load(id: string | undefined): void {
    this.loading.set(true);
    forkJoin({
      types: this.api.jobTypes(),
      job: id ? this.api.job(id) : of(null),
      runs: id ? this.api.runs(id, 10) : of({ items: [], total: 0 }),
    }).subscribe({
      next: ({ types, job, runs }) => {
        this.types.set(types);
        this.job.set(job);
        this.runs.set(runs.items);
        if (job) {
          this.form.reset({
            name: job.name,
            typeId: job.typeId,
            targetAlbumName: job.targetAlbumName,
            exclusionAlbumName: job.exclusionAlbumName ?? '',
            syncMode: job.syncMode,
            schedule: job.schedule ?? '',
            enabled: job.enabled,
          });
          this.form.controls.typeId.disable();
          this.resetParams(job.params);
        } else {
          this.form.controls.typeId.enable();
          const first = types.find((t) => t.id === 'screenshot-detector') ?? types[0];
          this.form.reset({ syncMode: 'dry-run', enabled: false, typeId: first?.id ?? '' });
        }
        this.typeId.set(this.form.controls.typeId.value);
        this.exclusionPlaceholder.set(this.defaultExclusion());
        this.loading.set(false);
      },
      error: () => this.loading.set(false),
    });
  }

  private resetParams(params: Record<string, unknown>): void {
    this.form.setControl('params', new FormGroup({}));
    this.paramsModel.set(clone(params));
  }

  save(): void {
    this.formErrors.set([]);
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }
    const v = this.form.getRawValue();
    const input: JobInput = {
      name: v.name.trim(),
      targetAlbumName: v.targetAlbumName.trim(),
      exclusionAlbumName: v.exclusionAlbumName.trim() || null,
      params: clone(this.paramsModel()),
      syncMode: v.syncMode,
      schedule: v.schedule.trim() || null,
      enabled: v.enabled,
    };
    const job = this.job();
    const toMirror = v.syncMode === 'mirror' && job?.syncMode !== 'mirror';
    const proceed = toMirror
      ? confirm(this.dialog, {
          title: 'Switch to mirror mode?',
          message:
            'In mirror mode, assets this app added to the album are removed again when they no longer match.\n' +
            'Assets you added by hand are never removed.',
          confirm: 'Use mirror mode',
          destructive: true,
        })
      : of(true);
    proceed.subscribe((ok) => {
      if (!ok) return;
      this.saving.set(true);
      const request = job
        ? this.api.updateJob(job.id, input)
        : this.api.createJob({ ...input, typeId: v.typeId });
      request.subscribe({
        next: (saved) => {
          this.saving.set(false);
          this.snackBar.open(job ? 'Job saved' : 'Job created', undefined, { duration: 3000 });
          if (job) {
            this.job.set(saved);
            this.form.markAsPristine();
          } else {
            void this.router.navigate(['/jobs', saved.id]);
          }
        },
        error: (err) => {
          this.saving.set(false);
          if (isValidationError(err))
            this.formErrors.set(applyServerErrors(this.form, err.error.errors));
        },
      });
    });
  }

  delete(): void {
    const job = this.job();
    if (!job) return;
    confirm(this.dialog, {
      title: `Delete "${job.name}"?`,
      message:
        'The job and its run history are deleted. The Immich albums and their assets stay as they are.',
      confirm: 'Delete',
      destructive: true,
    }).subscribe((ok) => {
      if (!ok) return;
      this.api.deleteJob(job.id).subscribe(() => {
        this.snackBar.open('Job deleted', undefined, { duration: 3000 });
        void this.router.navigate(['/jobs']);
      });
    });
  }

  start(dryRun: boolean, fullRescan = false): void {
    const job = this.job();
    if (!job) return;
    this.starting.set(true);
    this.api.startRun(job.id, { dryRun, fullRescan }).subscribe({
      next: (run) => void this.router.navigate(['/runs', run.id]),
      error: () => this.starting.set(false),
    });
  }

  serverError(name: keyof JobEditor['form']['controls']): string | null {
    return (this.form.controls[name].errors?.['server'] as string | undefined) ?? null;
  }
}
