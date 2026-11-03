import { Component, inject } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MAT_DIALOG_DATA, MatDialog, MatDialogModule } from '@angular/material/dialog';
import { map, type Observable } from 'rxjs';

export interface ConfirmData {
  title: string;
  message: string;
  confirm?: string;
  /** Red confirm button. */
  destructive?: boolean;
  /** Only an OK button (information, e.g. not available yet). */
  infoOnly?: boolean;
}

@Component({
  selector: 'app-confirm-dialog',
  imports: [MatDialogModule, MatButtonModule],
  template: `
    <h2 mat-dialog-title>{{ data.title }}</h2>
    <mat-dialog-content
      ><p class="message">{{ data.message }}</p></mat-dialog-content
    >
    <mat-dialog-actions align="end">
      @if (data.infoOnly) {
        <button matButton="filled" [mat-dialog-close]="false">OK</button>
      } @else {
        <button matButton [mat-dialog-close]="false">Cancel</button>
        <button matButton="filled" [class.destructive]="data.destructive" [mat-dialog-close]="true">
          {{ data.confirm ?? 'Confirm' }}
        </button>
      }
    </mat-dialog-actions>
  `,
  styles: `
    .message {
      white-space: pre-line;
    }
    .destructive {
      --mat-button-filled-container-color: var(--mat-sys-error);
      --mat-button-filled-label-text-color: var(--mat-sys-on-error);
    }
  `,
})
export class ConfirmDialog {
  protected readonly data = inject<ConfirmData>(MAT_DIALOG_DATA);
}

/** Opens a confirmation dialog; emits true when confirmed. */
export function confirm(dialog: MatDialog, data: ConfirmData): Observable<boolean> {
  return dialog
    .open<ConfirmDialog, ConfirmData, boolean>(ConfirmDialog, { data, width: '440px' })
    .afterClosed()
    .pipe(map((r) => r === true));
}
