import { Component, computed, input } from '@angular/core';
import type { RunStatus } from '../core/models';

const LABELS: Record<RunStatus, string> = {
  queued: 'Queued',
  running: 'Running',
  succeeded: 'Succeeded',
  failed: 'Failed',
  cancelled: 'Cancelled',
  interrupted: 'Interrupted',
};

/** Coloured run status pill. */
@Component({
  selector: 'app-status-chip',
  template: `<span class="chip" [class]="'chip ' + status()">{{ label() }}</span>`,
  styles: `
    .chip {
      display: inline-block;
      padding: 2px 10px;
      border-radius: 12px;
      font: var(--mat-sys-label-medium);
      background: var(--mat-sys-surface-container-high);
      color: var(--mat-sys-on-surface);
      white-space: nowrap;
    }
    .running,
    .queued {
      background: var(--mat-sys-primary-container);
      color: var(--mat-sys-on-primary-container);
    }
    .succeeded {
      background: #d7f5dd;
      color: #0b5e1f;
    }
    .failed {
      background: var(--mat-sys-error-container);
      color: var(--mat-sys-on-error-container);
    }
    .interrupted {
      background: #fff0c2;
      color: #6b4e00;
    }
  `,
})
export class StatusChip {
  readonly status = input.required<RunStatus>();
  protected readonly label = computed(() => LABELS[this.status()]);
}
