import { Component, computed, inject, signal, type OnInit } from '@angular/core';
import { FormControl, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatDialog } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatSnackBar } from '@angular/material/snack-bar';
import { Api } from '../../core/api';
import { isValidationError } from '../../core/error.interceptor';
import { applyServerErrors } from '../../core/form-errors';
import { HealthStore } from '../../core/health.store';
import type { FieldError, SettingsView } from '../../core/models';
import { confirm } from '../../shared/confirm-dialog';

@Component({
  selector: 'app-settings',
  imports: [
    ReactiveFormsModule,
    MatCardModule,
    MatButtonModule,
    MatIconModule,
    MatFormFieldModule,
    MatInputModule,
  ],
  templateUrl: './settings.html',
  styleUrl: './settings.scss',
})
export class Settings implements OnInit {
  private readonly api = inject(Api);
  private readonly snackBar = inject(MatSnackBar);
  private readonly dialog = inject(MatDialog);
  protected readonly store = inject(HealthStore);
  protected readonly health = this.store.health;
  protected readonly view = signal<SettingsView | null>(null);
  protected readonly saving = signal(false);

  protected readonly form = new FormGroup({
    'retention.dryRunCandidates': new FormControl(5, {
      nonNullable: true,
      validators: [Validators.required, Validators.min(1), Validators.max(100)],
    }),
    'retention.logDays': new FormControl(30, {
      nonNullable: true,
      validators: [Validators.required, Validators.min(1), Validators.max(3650)],
    }),
    'defaults.threshold': new FormControl(0.6, {
      nonNullable: true,
      validators: [Validators.required, Validators.min(0), Validators.max(1)],
    }),
  });

  protected readonly immichStatus = computed(() => {
    if (this.store.unreachable()) return 'Backend unreachable';
    const i = this.health()?.immich;
    if (!i) return 'Checking…';
    return i.status === 'up'
      ? `Connected (Immich ${i.version})`
      : i.status === 'incompatible'
        ? `Incompatible (${i.version})`
        : 'Not reachable';
  });

  ngOnInit(): void {
    this.api.settings().subscribe((v) => this.load(v));
  }

  private load(v: SettingsView): void {
    this.view.set(v);
    this.form.reset(v.settings);
  }

  save(): void {
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }
    this.saving.set(true);
    this.api.updateSettings(this.form.getRawValue()).subscribe({
      next: (v) => {
        this.saving.set(false);
        this.load(v);
        this.snackBar.open('Settings saved', undefined, { duration: 3000 });
      },
      error: (err) => {
        this.saving.set(false);
        if (isValidationError(err)) {
          applyServerErrors(
            this.form,
            err.error.errors.map((e: FieldError) => ({ ...e, path: [e.path.join('.')] })),
          );
        }
      },
    });
  }

  /** Downloads all job definitions as JSON. */
  exportJobs(): void {
    this.api.exportJobs().subscribe((body) => {
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(body, null, 2)], { type: 'application/json' }),
      );
      const a = document.createElement('a');
      a.href = url;
      a.download = `immich-album-jobs-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
    });
  }

  async importJobs(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    let body: { jobs?: unknown[] };
    try {
      body = JSON.parse(await file.text()) as { jobs?: unknown[] };
    } catch {
      this.snackBar.open('Not a JSON file', 'Dismiss', { duration: 5000 });
      return;
    }
    const count = Array.isArray(body.jobs) ? body.jobs.length : 0;
    confirm(this.dialog, {
      title: 'Import jobs?',
      message: `${count} job(s) in "${file.name}". Jobs whose name already exists are skipped; enabled schedules start running.`,
      confirm: 'Import',
    }).subscribe((ok) => {
      if (!ok) return;
      this.api.importJobs(body).subscribe((r) => {
        const parts = [`${r.created.length} imported`];
        if (r.skipped.length) parts.push(`${r.skipped.length} skipped (name exists)`);
        if (r.failed.length) parts.push(`${r.failed.length} invalid`);
        this.snackBar.open(parts.join(', '), 'OK', { duration: 8000 });
      });
    });
  }

  error(name: keyof Settings['form']['controls']): string | null {
    const c = this.form.controls[name];
    if (c.errors?.['server']) return c.errors['server'] as string;
    if (c.hasError('min') || c.hasError('max') || c.hasError('required')) return 'Out of range';
    return null;
  }
}
