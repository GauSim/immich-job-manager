import { BadRequestException, type PipeTransform } from '@nestjs/common';
import type { z } from 'zod';

export interface FieldError {
  path: (string | number)[];
  message: string;
}

/** 400 body: `{ message: 'Validation failed', errors: [{ path, message }] }` (same shape as Immich). */
export class ValidationFailedException extends BadRequestException {
  constructor(errors: FieldError[]) {
    super({ message: 'Validation failed', errors });
  }
}

export function zodErrors(
  error: z.ZodError,
  prefix: (string | number)[] = [],
): FieldError[] {
  return error.issues.map((i) => ({
    path: [
      ...prefix,
      ...i.path.map((p) => (typeof p === 'symbol' ? String(p) : p)),
    ],
    message: i.message,
  }));
}

/** `@Body(new ZodPipe(Schema))` */
export class ZodPipe<T extends z.ZodType> implements PipeTransform<
  unknown,
  z.infer<T>
> {
  constructor(private readonly schema: T) {}

  transform(value: unknown): z.infer<T> {
    const result = this.schema.safeParse(value ?? {});
    if (!result.success)
      throw new ValidationFailedException(zodErrors(result.error));
    return result.data;
  }
}
