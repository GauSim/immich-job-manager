import { Component, inject, input, signal } from '@angular/core';
import { FormControl, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import { HttpErrorResponse } from '@angular/common/http';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { Router } from '@angular/router';
import { AuthStore } from '../../core/auth.store';
import { HealthStore } from '../../core/health.store';

@Component({
  selector: 'app-login',
  imports: [
    ReactiveFormsModule,
    MatCardModule,
    MatFormFieldModule,
    MatInputModule,
    MatButtonModule,
  ],
  template: `
    <mat-card appearance="outlined" class="login">
      <mat-card-header><mat-card-title>Sign in</mat-card-title></mat-card-header>
      <mat-card-content>
        <form [formGroup]="form" (ngSubmit)="submit()">
          <mat-form-field class="full">
            <mat-label>Password</mat-label>
            <input
              matInput
              type="password"
              autocomplete="current-password"
              [formControl]="password"
              data-testid="password"
            />
            @if (error()) {
              <mat-error>{{ error() }}</mat-error>
            }
          </mat-form-field>
          <button
            matButton="filled"
            type="submit"
            [disabled]="busy()"
            class="full"
            data-testid="login"
          >
            Sign in
          </button>
        </form>
      </mat-card-content>
    </mat-card>
  `,
  styles: `
    .login {
      max-width: 380px;
      margin: 10vh auto 0;
    }
    form {
      display: grid;
      gap: 12px;
      padding-top: 12px;
    }
    .full {
      width: 100%;
    }
  `,
})
export class Login {
  private readonly auth = inject(AuthStore);
  private readonly router = inject(Router);
  private readonly health = inject(HealthStore);
  /** Query param set by the auth guard. */
  readonly returnUrl = input<string>();

  protected readonly password = new FormControl('', {
    nonNullable: true,
    validators: Validators.required,
  });
  protected readonly form = new FormGroup({ password: this.password });
  protected readonly busy = signal(false);
  protected readonly error = signal('');

  async submit(): Promise<void> {
    if (!this.password.value) return;
    this.busy.set(true);
    this.error.set('');
    try {
      await this.auth.login(this.password.value);
      this.health.refresh();
      await this.router.navigateByUrl(this.returnUrl() || '/jobs');
    } catch (e) {
      const status = e instanceof HttpErrorResponse ? e.status : 0;
      this.error.set(
        status === 429
          ? 'Too many attempts; try again later'
          : status === 401
            ? 'Wrong password'
            : 'Sign-in failed',
      );
      this.password.setErrors({ server: true });
      this.password.markAsTouched();
    } finally {
      this.busy.set(false);
    }
  }
}
