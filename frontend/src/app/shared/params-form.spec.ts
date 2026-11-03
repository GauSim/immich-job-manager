import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { FormGroup, type AbstractControl } from '@angular/forms';
import { provideFormlyCore, type FormlyFieldConfig } from '@ngx-formly/core';
import { FormlyJsonschema } from '@ngx-formly/core/json-schema';
import { formlyConfig } from './formly';
import { humanize, ParamsForm, schemaToFields } from './params-form';

/** JSON Schema as produced by the backend (z.toJSONSchema, draft-07) for screenshot-like params. */
const schema = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  type: 'object',
  properties: {
    threshold: {
      type: 'number',
      minimum: 0,
      maximum: 1,
      default: 0.6,
      description: 'Minimum score',
    },
    filenamePatterns: { type: 'array', items: { type: 'string' }, default: ['Screenshot'] },
    includeArchived: { type: 'boolean', default: false },
    clip: {
      type: 'object',
      properties: {
        enabled: { type: 'boolean', default: false },
        topN: { type: 'integer', minimum: 1, default: 2000 },
      },
    },
  },
};

@Component({
  imports: [ParamsForm],
  template: `<app-params-form [schema]="schema" [model]="model()" [form]="form" />`,
})
class Host {
  schema = schema;
  model = signal<Record<string, unknown>>({
    threshold: 0.6,
    filenamePatterns: ['Screenshot', 'Bildschirmfoto'],
    includeArchived: false,
    clip: { enabled: false, topN: 2000 },
  });
  form = new FormGroup<Record<string, AbstractControl<unknown>>>({});
}

describe('generated params form', () => {
  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [Host],
      providers: [provideFormlyCore(formlyConfig())],
    });
  });

  it('humanizes keys', () => {
    expect(humanize('pageSize')).toBe('Page size');
    expect(humanize('readIosTag')).toBe('Read iOS tag');
    expect(humanize('clip')).toBe('CLIP');
    expect(humanize('fillWithoutGps')).toBe('Fill without GPS');
    expect(humanize('topN')).toBe('Top N');
  });

  it('maps the schema to Formly field types', () => {
    const root = schemaToFields(TestBed.inject(FormlyJsonschema), schema);
    const byKey: Record<string, FormlyFieldConfig> = Object.fromEntries(
      (root.fieldGroup ?? []).map((f) => [String(f.key), f]),
    );
    expect(byKey['threshold'].type).toBe('number');
    expect(byKey['threshold'].props).toMatchObject({
      label: 'Threshold',
      description: 'Minimum score',
      min: 0,
      max: 1,
    });
    expect(byKey['filenamePatterns'].type).toBe('chips');
    expect(byKey['includeArchived'].type).toBe('boolean');
    expect(byKey['clip'].type).toBe('object');
    expect(byKey['clip'].fieldGroup?.map((f) => f.key)).toEqual(['enabled', 'topN']);
  });

  it('renders inputs, chips and toggles bound to the model', async () => {
    const fixture = TestBed.createComponent(Host);
    fixture.detectChanges();
    await fixture.whenStable();
    const el = fixture.nativeElement as HTMLElement;
    expect(el.textContent).toContain('Threshold');
    expect(
      [...el.querySelectorAll('mat-chip-row')].map((c) =>
        c.textContent?.replace('cancel', '').trim(),
      ),
    ).toEqual(['Screenshot', 'Bildschirmfoto']);
    expect(el.querySelectorAll('mat-slide-toggle').length).toBe(2);
    expect(el.querySelector('legend')?.textContent).toContain('CLIP');

    const input = el.querySelector('input[type=number]') as HTMLInputElement;
    expect(input.value).toBe('0.6');
    input.value = '0.8';
    input.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    expect(fixture.componentInstance.model()['threshold']).toBe(0.8);
    expect(fixture.componentInstance.form.get('threshold')?.value).toBe(0.8);
  });

  it('validates schema limits', async () => {
    const fixture = TestBed.createComponent(Host);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.componentInstance.form.get('threshold')?.setValue(2);
    expect(fixture.componentInstance.form.get('threshold')?.hasError('max')).toBe(true);
  });
});
