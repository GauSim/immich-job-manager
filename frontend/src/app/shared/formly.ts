import { COMMA, ENTER } from '@angular/cdk/keycodes';
import { Component } from '@angular/core';
import { ReactiveFormsModule } from '@angular/forms';
import { MatChipsModule, type MatChipInputEvent } from '@angular/material/chips';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import {
  FieldType,
  FormlyAttributes,
  FormlyModule,
  type ConfigOption,
  type FieldTypeConfig,
} from '@ngx-formly/core';
import { withFormlyMaterial } from '@ngx-formly/material';

/** String list as Material chips (e.g. file name patterns, resolutions). */
@Component({
  selector: 'app-formly-chips',
  imports: [ReactiveFormsModule, MatChipsModule, MatFormFieldModule, MatIconModule],
  template: `
    <mat-form-field class="full">
      <mat-label>{{ props.label }}</mat-label>
      <mat-chip-grid #grid [formControl]="formControl" [attr.aria-label]="props.label">
        @for (item of values(); track $index) {
          <mat-chip-row (removed)="remove($index)">
            {{ item }}
            <button matChipRemove [attr.aria-label]="'Remove ' + item">
              <mat-icon>cancel</mat-icon>
            </button>
          </mat-chip-row>
        }
        <input
          [placeholder]="props.placeholder ?? 'Add…'"
          [matChipInputFor]="grid"
          [matChipInputSeparatorKeyCodes]="separators"
          (matChipInputTokenEnd)="add($event)"
        />
      </mat-chip-grid>
      @if (props.description) {
        <mat-hint>{{ props.description }}</mat-hint>
      }
    </mat-form-field>
  `,
  styles: `
    .full {
      width: 100%;
    }
  `,
})
export class ChipsType extends FieldType<FieldTypeConfig> {
  protected readonly separators = [ENTER, COMMA];

  values(): string[] {
    return (this.formControl.value as string[] | null) ?? [];
  }

  add(event: MatChipInputEvent): void {
    const value = event.value.trim();
    if (value && !this.values().includes(value))
      this.formControl.setValue([...this.values(), value]);
    this.formControl.markAsDirty();
    event.chipInput.clear();
  }

  remove(index: number): void {
    this.formControl.setValue(this.values().filter((_, i) => i !== index));
    this.formControl.markAsDirty();
  }
}

/** Boolean as a plain slide toggle with its description below. */
@Component({
  selector: 'app-formly-toggle',
  imports: [ReactiveFormsModule, MatSlideToggleModule, FormlyAttributes],
  template: `
    <mat-slide-toggle [formControl]="formControl" [formlyAttributes]="field">{{
      props.label
    }}</mat-slide-toggle>
    @if (props.description) {
      <div class="hint">{{ props.description }}</div>
    }
  `,
  styles: `
    .hint {
      color: var(--mat-sys-on-surface-variant);
      font: var(--mat-sys-body-small);
      margin: 4px 0 0 52px;
    }
  `,
})
export class ToggleType extends FieldType<FieldTypeConfig> {}

/** Nested object (e.g. `clip`): a titled group of fields. */
@Component({
  selector: 'app-formly-object',
  imports: [FormlyModule],
  template: `
    <fieldset class="group">
      @if (props.label) {
        <legend>{{ props.label }}</legend>
      }
      @if (props.description) {
        <p class="hint">{{ props.description }}</p>
      }
      @for (f of field.fieldGroup; track $index) {
        <formly-field [field]="f" />
      }
    </fieldset>
  `,
  styles: `
    .group {
      border: 1px solid var(--mat-sys-outline-variant);
      border-radius: 8px;
      padding: 8px 16px;
      margin: 8px 0 16px;
    }
    legend {
      font: var(--mat-sys-title-small);
      padding: 0 4px;
    }
    .hint {
      color: var(--mat-sys-on-surface-variant);
      font: var(--mat-sys-body-small);
      margin: 0 0 8px;
    }
  `,
})
export class ObjectType extends FieldType {}

/** Formly config for forms generated from JSON Schema (SDD §2.1: no frontend code per job type). */
export function formlyConfig(): ConfigOption[] {
  return [
    ...withFormlyMaterial(),
    {
      types: [
        { name: 'string', extends: 'input' },
        { name: 'number', extends: 'input', defaultOptions: { props: { type: 'number' } } },
        { name: 'integer', extends: 'input', defaultOptions: { props: { type: 'number' } } },
        { name: 'boolean', component: ToggleType, wrappers: [] },
        { name: 'enum', extends: 'select' },
        { name: 'object', component: ObjectType, wrappers: [] },
        { name: 'chips', component: ChipsType, wrappers: [] },
      ],
      validationMessages: [
        { name: 'required', message: 'Required' },
        { name: 'min', message: (_e, f) => `Must be at least ${f.props?.min}` },
        { name: 'max', message: (_e, f) => `Must be at most ${f.props?.max}` },
        { name: 'pattern', message: 'Invalid format' },
        { name: 'server', message: (e: unknown) => String(e) },
      ],
    },
  ];
}
