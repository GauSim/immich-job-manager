import { Component, computed, inject, input } from '@angular/core';
import { FormGroup } from '@angular/forms';
import { FormlyForm, type FormlyFieldConfig } from '@ngx-formly/core';
import { FormlyJsonschema } from '@ngx-formly/core/json-schema';
import type { JSONSchema7 } from 'json-schema';

/** `pageSize` → "Page size" */
export function humanize(key: string): string {
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .toLowerCase()
    .replace(/\bclip\b/g, 'CLIP')
    .replace(/\bios\b/g, 'iOS')
    .replace(/\btop n\b/g, 'top N');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Converts a job type's params JSON Schema into Formly fields. */
export function schemaToFields(
  jsonschema: FormlyJsonschema,
  schema: Record<string, unknown>,
): FormlyFieldConfig {
  return jsonschema.toFieldConfig(schema as JSONSchema7, {
    map: (field, s) => {
      field.props ??= {};
      if (!field.props.label && field.key !== undefined)
        field.props.label = humanize(String(field.key));
      if (s.description) field.props.description = s.description;
      const items = s.items as JSONSchema7 | undefined;
      if (s.type === 'array' && items && !Array.isArray(items) && items.type === 'string') {
        field.type = 'chips';
        delete field.fieldArray;
      }
      return field;
    },
  });
}

/**
 * Job params form generated from the job type's JSON Schema.
 * The parent owns `form` (a FormGroup) and `model`.
 */
@Component({
  selector: 'app-params-form',
  imports: [FormlyForm],
  template: `<formly-form [form]="form()" [fields]="fields()" [model]="model()" />`,
  styles: `
    :host ::ng-deep formly-field {
      display: block;
    }
    :host ::ng-deep formly-field + formly-field,
    :host ::ng-deep legend + formly-field,
    :host ::ng-deep .hint + formly-field {
      margin-top: 16px;
    }
  `,
})
export class ParamsForm {
  private readonly jsonschema = inject(FormlyJsonschema);
  readonly schema = input.required<Record<string, unknown>>();
  readonly model = input.required<Record<string, unknown>>();
  readonly form = input.required<FormGroup>();

  protected readonly fields = computed(() => {
    const root = schemaToFields(this.jsonschema, this.schema());
    // Render the top-level object's fields directly (no extra group frame).
    return root.fieldGroup ?? [root];
  });
}
