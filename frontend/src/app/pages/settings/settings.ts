import { Component, computed, inject } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatIconModule } from '@angular/material/icon';
import { HealthStore } from '../../core/health.store';

@Component({
  selector: 'app-settings',
  imports: [MatCardModule, MatButtonModule, MatIconModule],
  template: `
    <div class="page-header"><h1>Settings</h1></div>
    <div class="card-grid">
      <mat-card appearance="outlined">
        <mat-card-header>
          <mat-card-title>Immich connection</mat-card-title>
          <mat-card-subtitle
            >URL and API key are set in the environment (.env / Docker secrets)</mat-card-subtitle
          >
        </mat-card-header>
        <mat-card-content>
          <dl>
            <dt>Status</dt>
            <dd data-testid="settings-immich">{{ immichStatus() }}</dd>
            <dt>Database</dt>
            <dd>{{ health()?.database?.status ?? '–' }}</dd>
            @if (health()?.immich?.error; as e) {
              <dt>Error</dt>
              <dd class="error-text">{{ e }}</dd>
            }
          </dl>
        </mat-card-content>
        <mat-card-actions>
          <button matButton (click)="store.refresh()">
            <mat-icon>refresh</mat-icon>Test connection
          </button>
        </mat-card-actions>
      </mat-card>
      <mat-card appearance="outlined">
        <mat-card-header><mat-card-title>More settings</mat-card-title></mat-card-header>
        <mat-card-content class="muted">
          Retention, defaults for new jobs, and job export/import arrive in phase 8.
        </mat-card-content>
      </mat-card>
    </div>
  `,
  styles: `
    dl {
      display: grid;
      grid-template-columns: max-content 1fr;
      gap: 8px 24px;
      margin: 16px 0 0;
    }
    dt {
      color: var(--mat-sys-on-surface-variant);
    }
    dd {
      margin: 0;
    }
  `,
})
export class Settings {
  protected readonly store = inject(HealthStore);
  protected readonly health = this.store.health;
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
}
