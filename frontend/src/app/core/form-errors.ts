import type { AbstractControl, FormGroup } from '@angular/forms';
import type { FieldError } from './models';

/**
 * Puts backend field errors on the matching controls as `{ server: message }`.
 * Returns the errors that matched no control (show them elsewhere).
 */
export function applyServerErrors(form: FormGroup, errors: FieldError[]): FieldError[] {
  const unmatched: FieldError[] = [];
  for (const e of errors) {
    const control: AbstractControl | null = e.path.length ? form.get(e.path.map(String)) : null;
    if (control) {
      control.setErrors({ ...(control.errors ?? {}), server: e.message });
      control.markAsTouched();
    } else {
      unmatched.push(e);
    }
  }
  return unmatched;
}
